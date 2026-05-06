mod grpc_tracker;

use std::any::Any;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, RwLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime};

use anyhow::{Context, Result, anyhow};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use clap::Parser;
use rand::Rng;
use reqwest::blocking::Client as HttpClient;
use reqwest::header::{CONNECTION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use solana_client::rpc_client::RpcClient;
use solana_client::rpc_config::{RpcSendTransactionConfig, UiTransactionEncoding};
use solana_commitment_config::CommitmentConfig;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_sdk::hash::Hash;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signature, Signer};
use solana_sdk::transaction::Transaction;
use solana_system_interface::instruction as system_instruction;

use crate::grpc_tracker::{GrpcTracker, LandingEvent};

const SOL_FEE_BUFFER_LAMPORTS: u64 = 50_000;
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(2);
const GRPC_WARMUP: Duration = Duration::from_secs(5);
const BLOCKHASH_REFRESH_INTERVAL: Duration = Duration::from_millis(400);
const SLOT_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Parser, Debug)]
#[command(about = "Run Solana sendTransaction benchmark")]
struct Args {
    #[arg(long, default_value_t = 1)]
    runs: usize,
    #[arg(long)]
    output: Option<String>,
    #[arg(long, default_value = "config.toml")]
    config: String,
    #[arg(long)]
    providers: Option<String>,
    #[arg(long, hide = true)]
    provider: Option<String>,
    #[arg(long)]
    markdown_output: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BenchConfigFile {
    #[serde(default)]
    global: Vec<GlobalConfig>,
    #[serde(default)]
    receiver: Vec<ActorConfig>,
    #[serde(default)]
    sender: Vec<ActorConfig>,
    #[serde(default)]
    provider: Vec<ProviderConfig>,
}

#[derive(Debug, Deserialize)]
struct ActorConfig {
    pubkey: String,
    private_key: String,
}

#[derive(Debug, Deserialize)]
struct ProviderConfig {
    name: String,
    rpc_url: Option<String>,
    send_tx_rpc_url: Option<String>,
    sender_pubkey: Option<String>,
    sender_private_key: Option<String>,
    #[serde(default)]
    tip_accounts: Vec<String>,
    tip_amount: Option<u64>,
    compute_unit_limit: Option<u32>,
    compute_unit_price_micro_lamports: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct GlobalConfig {
    tip_amount: u64,
    compute_unit_limit: u32,
    compute_unit_price_micro_lamports: u64,
    rpc_url: String,
    send_tx_rpc_url: String,
    grpc_url: String,
    #[serde(default)]
    grpc_x_token: Option<String>,
    #[serde(default)]
    grpc_tracking_url: Option<String>,
    #[serde(default)]
    grpc_tracking_x_token: Option<String>,
}

#[derive(Clone)]
struct RuntimeConfig {
    provider_name: String,
    rpc_url: String,
    send_tx_rpc_url: String,
    sender_pubkey: Pubkey,
    sender_private_key_path: String,
    tip_accounts: Vec<Pubkey>,
    tip_amount: u64,
    compute_unit_limit: u32,
    compute_unit_price_micro_lamports: u64,
}

struct LoadedConfig {
    default_sender_pubkey: Pubkey,
    receiver_pubkey: Pubkey,
    providers: Vec<ProviderRuntime>,
    grpc_url: String,
    grpc_x_token: Option<String>,
    grpc_tracking_url: Option<String>,
    grpc_tracking_x_token: Option<String>,
}

#[derive(Clone)]
struct ProviderRuntime {
    name: String,
    rpc_url: String,
    send_tx_rpc_url: String,
    sender_pubkey: Pubkey,
    sender_private_key_path: String,
    tip_accounts: Vec<Pubkey>,
    tip_amount: u64,
    compute_unit_limit: u32,
    compute_unit_price_micro_lamports: u64,
}

#[derive(Debug, Serialize)]
struct RunResult {
    signature: String,
    triggered_slot: u64,
    submit_slot: u64,
    landed_slot: Option<u64>,
    landed_index_in_block: Option<usize>,
    submit_to_landed_slots: Option<i64>,
    same_slot_landed: bool,
    send_ack_ms: f64,
    submit_to_landed_ms: Option<f64>,
    submit_to_landed_grpc_ms: Option<f64>,
    submit_to_block_received_ms: Option<f64>,
    priority_fee: u64,
    timed_out: bool,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct Averages {
    avg_send_ack_ms: f64,
    avg_submit_to_landed_ms: f64,
    avg_submit_to_landed_grpc_ms: f64,
    avg_submit_to_block_received_ms: f64,
    avg_submit_to_landed_slots: f64,
    avg_landed_index_in_block: f64,
    avg_priority_fee: f64,
    max_submit_to_landed_slots: i64,
    min_submit_to_landed_slots: i64,
    same_slot_landed_count: usize,
    landed_runs: usize,
    block_seen_runs: usize,
    total_runs: usize,
}

#[derive(Debug, Serialize)]
struct OutputData {
    provider_name: String,
    sender_pubkey: String,
    receiver_pubkey: String,
    results: Vec<RunResult>,
    averages: Averages,
}

#[derive(Debug, Serialize)]
struct Percentiles {
    p90_send_ack_ms: f64,
    p90_submit_to_landed_ms: f64,
    p90_submit_to_landed_grpc_ms: f64,
    p90_submit_to_block_received_ms: f64,
    p90_submit_to_landed_slots: f64,
    p90_landed_index_in_block: f64,
}

struct ProviderBenchmark {
    provider_name: String,
    sender_pubkey: Pubkey,
    results: Vec<RunResult>,
    averages: Averages,
    percentiles: Percentiles,
}

#[derive(Debug, Serialize)]
struct MultiProviderOutputData<'a> {
    generated_at: String,
    sender_pubkey: String,
    receiver_pubkey: String,
    runs_per_provider: usize,
    selected_providers: Vec<String>,
    providers: Vec<ProviderComparisonOutput<'a>>,
}

#[derive(Debug, Serialize)]
struct ProviderComparisonOutput<'a> {
    provider_name: &'a str,
    sender_pubkey: String,
    success_landing_ratio_pct: f64,
    performance_rate_pct: f64,
    averages: &'a Averages,
    percentiles: &'a Percentiles,
    results: &'a [RunResult],
}

#[derive(Clone, Copy, Debug)]
struct ProviderPerformance {
    success_landing_ratio_pct: f64,
    performance_rate_pct: f64,
}

struct PersistentRpcSender {
    rpc_url: String,
    request_id: AtomicU64,
    client: HttpClient,
}

impl PersistentRpcSender {
    fn new(rpc_url: String) -> Result<Self> {
        // HTTP/2 negotiated via ALPN (rustls advertises h2 by default). h2 multiplexes
        // requests over a single TCP connection, so we keep just one warm in the pool
        // and rely on the connection's stream concurrency for parallel sends.
        let client = HttpClient::builder()
            .pool_max_idle_per_host(1)
            .pool_idle_timeout(Duration::from_secs(90))
            .timeout(Duration::from_secs(10))
            .http2_adaptive_window(true)
            .build()
            .context("failed to build persistent HTTP client")?;

        Ok(Self {
            rpc_url,
            request_id: AtomicU64::new(0),
            client,
        })
    }

    fn send_transaction(&self, tx: &Transaction) -> Result<String> {
        let request_id = self.request_id.fetch_add(1, Ordering::Relaxed) + 1;
        let encoded_tx = BASE64_STANDARD
            .encode(bincode::serialize(tx).context("failed to serialize transaction")?);

        let payload = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "sendTransaction",
            "params": [
                encoded_tx,
                RpcSendTransactionConfig {
                    skip_preflight: true,
                    preflight_commitment: None,
                    encoding: Some(UiTransactionEncoding::Base64),
                    max_retries: Some(0),
                    min_context_slot: None,
                }
            ]
        });

        for attempt in 0..2 {
            match self
                .client
                .post(&self.rpc_url)
                .header(CONTENT_TYPE, "application/json")
                .header(CONNECTION, "keep-alive")
                .json(&payload)
                .send()
            {
                Ok(response) => {
                    let status = response.status();
                    let body_text = response
                        .text()
                        .context("failed to read sendTransaction response body")?;
                    if !status.is_success() {
                        return Err(anyhow!(
                            "sendTransaction HTTP error: {} body={}",
                            status,
                            body_text
                        ));
                    }

                    let body: Value =
                        serde_json::from_str(&body_text).context("invalid JSON-RPC response")?;
                    if let Some(error) = body.get("error") {
                        return Err(anyhow!("sendTransaction RPC error: {}", error));
                    }
                    if let Some(signature) = body.get("result").and_then(Value::as_str) {
                        return Ok(signature.to_string());
                    }
                    return Err(anyhow!("invalid sendTransaction response: {}", body_text));
                }
                Err(err) => {
                    if attempt == 1 {
                        return Err(anyhow!("sendTransaction request failed: {}", err));
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }

        Err(anyhow!("sendTransaction request failed after retries"))
    }
}

fn main() -> Result<()> {
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .map_err(|_| anyhow!("failed to install aws-lc-rs default crypto provider"))?;

    let args = Args::parse();
    if args.providers.is_some() && args.provider.is_some() {
        return Err(anyhow!(
            "use only one of --providers or --provider (deprecated alias)"
        ));
    }
    let loaded = LoadedConfig::from_toml(&args)?;
    let provider_selector = args.providers.as_deref().or(args.provider.as_deref());
    let selected_providers = resolve_selected_providers(&loaded.providers, provider_selector)?;
    let selected_names = selected_providers
        .iter()
        .map(|p| p.name.clone())
        .collect::<Vec<_>>();

    println!("Selected providers: {}", selected_names.join(", "));
    println!("Default sender: {}", loaded.default_sender_pubkey);
    println!("Selected receiver: {}", loaded.receiver_pubkey);

    preflight_balance_check(&selected_providers, args.runs)?;

    let mut sender_pubkey_set: HashSet<String> = HashSet::new();
    for provider in &selected_providers {
        sender_pubkey_set.insert(provider.sender_pubkey.to_string());
    }
    let sender_pubkeys: Vec<String> = sender_pubkey_set.into_iter().collect();

    match &loaded.grpc_tracking_url {
        Some(track) => println!(
            "Connecting to gRPC: primary (blocks) {} | tracking (slots+transactions) {} | filtering on {} sender pubkey(s)...",
            loaded.grpc_url,
            track,
            sender_pubkeys.len()
        ),
        None => println!(
            "Connecting to Yellowstone gRPC at {} (filtering on {} sender pubkey(s))...",
            loaded.grpc_url,
            sender_pubkeys.len()
        ),
    }
    let grpc = Arc::new(GrpcTracker::new(
        loaded.grpc_url.clone(),
        loaded.grpc_x_token.clone(),
        loaded.grpc_tracking_url.clone(),
        loaded.grpc_tracking_x_token.clone(),
        sender_pubkeys,
    )?);
    println!(
        "gRPC subscriber ready (current slot {}). Warming up for {}s...",
        grpc.current_slot(),
        GRPC_WARMUP.as_secs()
    );
    thread::sleep(GRPC_WARMUP);
    println!("Warmup complete (current slot {}).", grpc.current_slot());

    let mut indexed_benchmarks = Vec::new();
    thread::scope(|scope| -> Result<()> {
        let mut handles = Vec::new();
        for (idx, provider) in selected_providers.into_iter().enumerate() {
            let runtime = RuntimeConfig {
                provider_name: provider.name.clone(),
                rpc_url: provider.rpc_url.clone(),
                send_tx_rpc_url: provider.send_tx_rpc_url.clone(),
                sender_pubkey: provider.sender_pubkey,
                sender_private_key_path: provider.sender_private_key_path.clone(),
                tip_accounts: provider.tip_accounts.clone(),
                tip_amount: provider.tip_amount,
                compute_unit_limit: provider.compute_unit_limit,
                compute_unit_price_micro_lamports: provider.compute_unit_price_micro_lamports,
            };
            let runs = args.runs;
            let grpc = Arc::clone(&grpc);
            handles.push(scope.spawn(move || -> Result<(usize, ProviderBenchmark)> {
                println!("\n=== Provider: {} ===", runtime.provider_name);
                println!("Sender: {}", runtime.sender_pubkey);
                println!(
                    "CU limit: {}, CU price: {} μlamports/CU",
                    runtime.compute_unit_limit, runtime.compute_unit_price_micro_lamports
                );
                println!("Configured tip accounts: {}", runtime.tip_accounts.len());

                let benchmark = run_provider_benchmark(&runtime, runs, &grpc)?;
                Ok((idx, benchmark))
            }));
        }

        for handle in handles {
            let worker_output = handle
                .join()
                .map_err(|panic_payload| anyhow!(panic_payload_to_string(panic_payload)))?;
            let indexed = worker_output?;
            indexed_benchmarks.push(indexed);
        }
        Ok(())
    })?;

    indexed_benchmarks.sort_by_key(|(idx, _)| *idx);
    let benchmarks = indexed_benchmarks
        .into_iter()
        .map(|(_, benchmark)| benchmark)
        .collect::<Vec<_>>();

    if benchmarks.len() == 1 {
        if args.markdown_output.is_some() {
            println!("Ignoring --markdown-output for single provider run");
        }
        let benchmark = benchmarks
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("missing benchmark result"))?;
        let output_data = OutputData {
            provider_name: benchmark.provider_name,
            sender_pubkey: benchmark.sender_pubkey.to_string(),
            receiver_pubkey: loaded.receiver_pubkey.to_string(),
            results: benchmark.results,
            averages: benchmark.averages,
        };
        let filename = args
            .output
            .unwrap_or_else(|| format!("transfer_results_{}.json", timestamp_for_filename()));

        fs::write(&filename, serde_json::to_string_pretty(&output_data)?)
            .with_context(|| format!("failed to write output file: {}", filename))?;

        println!("\nResults saved to {}", filename);
        println!("\nFinal Results:");
        println!("{}", serde_json::to_string_pretty(&output_data)?);
        return Ok(());
    }

    let performance = compute_provider_performance(&benchmarks);
    let markdown = render_markdown_report(
        &benchmarks,
        &performance,
        loaded.default_sender_pubkey,
        loaded.receiver_pubkey,
        args.runs,
        &selected_names,
    );
    let filename = args
        .markdown_output
        .or(args.output)
        .unwrap_or_else(|| format!("provider_comparison_{}.md", timestamp_for_filename()));
    fs::write(&filename, markdown)
        .with_context(|| format!("failed to write markdown output file: {}", filename))?;
    let comparison_json = build_multi_provider_output_data(
        &benchmarks,
        &performance,
        &loaded,
        args.runs,
        &selected_names,
    );
    let json_filename = derive_json_report_filename(&filename);
    fs::write(
        &json_filename,
        serde_json::to_string_pretty(&comparison_json)?,
    )
    .with_context(|| format!("failed to write JSON output file: {}", json_filename))?;

    println!("\nComparison report saved to {}", filename);
    println!("Comparison JSON saved to {}", json_filename);

    Ok(())
}

impl LoadedConfig {
    fn from_toml(args: &Args) -> Result<Self> {
        let config_text = fs::read_to_string(&args.config)
            .with_context(|| format!("failed to read config file: {}", args.config))?;
        let config_file: BenchConfigFile =
            toml::from_str(&config_text).context("invalid config TOML format")?;

        if config_file.sender.is_empty() {
            return Err(anyhow!("config requires at least one [[sender]] section"));
        }
        if config_file.receiver.is_empty() {
            return Err(anyhow!("config requires at least one [[receiver]] section"));
        }
        if config_file.global.is_empty() {
            return Err(anyhow!("config requires at least one [[global]] section"));
        }
        if config_file.provider.is_empty() {
            return Err(anyhow!("config requires at least one [[provider]] section"));
        }
        let global = config_file
            .global
            .first()
            .ok_or_else(|| anyhow!("config requires at least one [[global]] section"))?;

        let selected_sender = config_file
            .sender
            .first()
            .ok_or_else(|| anyhow!("config requires at least one [[sender]] section"))?;
        let selected_receiver = config_file
            .receiver
            .first()
            .ok_or_else(|| anyhow!("config requires at least one [[receiver]] section"))?;
        let sender_pubkey =
            Pubkey::from_str(&selected_sender.pubkey).context("invalid sender pubkey in config")?;
        let receiver_pubkey = Pubkey::from_str(&selected_receiver.pubkey)
            .context("invalid receiver pubkey in config")?;

        let mut providers = Vec::with_capacity(config_file.provider.len());
        for provider in &config_file.provider {
            let provider_sender_pubkey = match &provider.sender_pubkey {
                Some(value) => Pubkey::from_str(value).with_context(|| {
                    format!("invalid sender_pubkey at provider '{}'", provider.name)
                })?,
                None => sender_pubkey,
            };
            let provider_sender_private_key = match &provider.sender_private_key {
                Some(value) => value.clone(),
                None => selected_sender.private_key.clone(),
            };
            if provider.sender_pubkey.is_some() != provider.sender_private_key.is_some() {
                return Err(anyhow!(
                    "provider '{}' must set both sender_pubkey and sender_private_key together",
                    provider.name
                ));
            }
            let mut tip_accounts = Vec::with_capacity(provider.tip_accounts.len());
            for (idx, tip_account) in provider.tip_accounts.iter().enumerate() {
                let parsed = Pubkey::from_str(tip_account).with_context(|| {
                    format!(
                        "invalid tip account at provider '{}' tip_accounts[{}]",
                        provider.name, idx
                    )
                })?;
                tip_accounts.push(parsed);
            }
            providers.push(ProviderRuntime {
                name: provider.name.clone(),
                rpc_url: provider
                    .rpc_url
                    .clone()
                    .unwrap_or_else(|| global.rpc_url.clone()),
                send_tx_rpc_url: provider
                    .send_tx_rpc_url
                    .clone()
                    .unwrap_or_else(|| global.send_tx_rpc_url.clone()),
                sender_pubkey: provider_sender_pubkey,
                sender_private_key_path: provider_sender_private_key,
                tip_accounts,
                tip_amount: provider.tip_amount.unwrap_or(global.tip_amount),
                compute_unit_limit: provider
                    .compute_unit_limit
                    .unwrap_or(global.compute_unit_limit),
                compute_unit_price_micro_lamports: provider
                    .compute_unit_price_micro_lamports
                    .unwrap_or(global.compute_unit_price_micro_lamports),
            });
        }

        Ok(Self {
            default_sender_pubkey: sender_pubkey,
            receiver_pubkey,
            providers,
            grpc_url: global.grpc_url.clone(),
            grpc_x_token: global.grpc_x_token.clone(),
            grpc_tracking_url: global.grpc_tracking_url.clone(),
            grpc_tracking_x_token: global.grpc_tracking_x_token.clone(),
        })
    }
}

struct ProviderRunner {
    sender: Keypair,
    blockhash: Arc<RwLock<Hash>>,
    shutdown: Arc<AtomicBool>,
    blockhash_thread: Option<JoinHandle<()>>,
}

impl ProviderRunner {
    fn new(config: &RuntimeConfig) -> Result<Self> {
        let rpc_client = RpcClient::new_with_commitment(
            config.rpc_url.clone(),
            CommitmentConfig::processed(),
        );
        let sender = read_sender_keypair(&config.sender_private_key_path, config.sender_pubkey)?;

        let (initial_hash, _) = rpc_client
            .get_latest_blockhash_with_commitment(CommitmentConfig::processed())
            .context("failed to fetch initial blockhash")?;
        drop(rpc_client);
        let blockhash = Arc::new(RwLock::new(initial_hash));
        let shutdown = Arc::new(AtomicBool::new(false));

        let blockhash_clone = Arc::clone(&blockhash);
        let shutdown_clone = Arc::clone(&shutdown);
        let rpc_url = config.rpc_url.clone();
        let provider_name = config.provider_name.clone();
        let blockhash_thread = thread::Builder::new()
            .name(format!("blockhash-refresh-{}", provider_name))
            .spawn(move || {
                let client =
                    RpcClient::new_with_commitment(rpc_url, CommitmentConfig::processed());
                while !shutdown_clone.load(Ordering::Relaxed) {
                    match client
                        .get_latest_blockhash_with_commitment(CommitmentConfig::processed())
                    {
                        Ok((hash, _)) => {
                            if let Ok(mut guard) = blockhash_clone.write() {
                                *guard = hash;
                            }
                        }
                        Err(e) => {
                            eprintln!(
                                "[{}] blockhash refresh error: {}",
                                provider_name, e
                            );
                        }
                    }
                    thread::sleep(BLOCKHASH_REFRESH_INTERVAL);
                }
            })
            .context("failed to spawn blockhash refresher thread")?;

        Ok(Self {
            sender,
            blockhash,
            shutdown,
            blockhash_thread: Some(blockhash_thread),
        })
    }

    fn current_blockhash(&self) -> Hash {
        *self.blockhash.read().expect("blockhash lock poisoned")
    }
}

impl Drop for ProviderRunner {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(handle) = self.blockhash_thread.take() {
            let _ = handle.join();
        }
    }
}

fn run_provider_benchmark(
    config: &RuntimeConfig,
    runs: usize,
    grpc: &GrpcTracker,
) -> Result<ProviderBenchmark> {
    let send_tx_sender = PersistentRpcSender::new(config.send_tx_rpc_url.clone())?;
    let runner = ProviderRunner::new(config)?;

    // Sequential per-provider dispatch gated by Aperture slot ticks: each run waits
    // for the next slot edge and submits immediately so we maximize the chance of
    // landing near the front of the upcoming block.
    let mut results: Vec<RunResult> = Vec::with_capacity(runs);
    let mut last_slot = grpc.current_slot();
    for i in 0..runs {
        let triggered_slot = grpc
            .wait_for_next_slot(last_slot, SLOT_WAIT_TIMEOUT)
            .ok_or_else(|| {
                anyhow!(
                    "[{}] timed out waiting for next slot tick from gRPC ({}s)",
                    config.provider_name,
                    SLOT_WAIT_TIMEOUT.as_secs()
                )
            })?;
        last_slot = triggered_slot;
        println!(
            "[{}] run {}/{} triggered by slot {}",
            config.provider_name,
            i + 1,
            runs,
            triggered_slot
        );
        let result = run_transfer(config, &send_tx_sender, grpc, &runner, i, triggered_slot)?;
        println!("{}", serde_json::to_string(&result)?);
        results.push(result);
    }

    let averages = compute_averages(&results, runs);
    let percentiles = compute_percentiles(&results);
    Ok(ProviderBenchmark {
        provider_name: config.provider_name.clone(),
        sender_pubkey: config.sender_pubkey,
        results,
        averages,
        percentiles,
    })
}

fn run_transfer(
    config: &RuntimeConfig,
    send_tx_sender: &PersistentRpcSender,
    grpc: &GrpcTracker,
    runner: &ProviderRunner,
    run_idx: usize,
    triggered_slot: u64,
) -> Result<RunResult> {
    let sender_pubkey = runner.sender.pubkey();
    let tip_account = select_tip_account(&config.tip_accounts);

    // Small per-run jitter on tip so parallel runs that share a blockhash and a
    // randomly-picked tip account still produce unique signatures (deduping by
    // the validator would otherwise drop all but the first).
    let tip_jitter: u64 = rand::thread_rng().gen_range(0..1024);
    let tip_amount = config.tip_amount + tip_jitter;

    let mut ixs = Vec::with_capacity(3);
    ixs.push(ComputeBudgetInstruction::set_compute_unit_limit(
        config.compute_unit_limit,
    ));
    ixs.push(ComputeBudgetInstruction::set_compute_unit_price(
        config.compute_unit_price_micro_lamports,
    ));
    if let Some(tip_account) = tip_account {
        ixs.push(system_instruction::transfer(
            &sender_pubkey,
            &tip_account,
            tip_amount,
        ));
    }

    let recent_blockhash = runner.current_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &ixs,
        Some(&sender_pubkey),
        &[&runner.sender],
        recent_blockhash,
    );
    println!(
        "[{}] run {} | tip account: {} | tip: {}",
        config.provider_name,
        run_idx + 1,
        tip_account
            .map(|acc| acc.to_string())
            .unwrap_or_else(|| "none".to_string()),
        tip_amount,
    );
    // Compute the signature locally before POST so we can register the pending
    // entry first. Otherwise the gRPC tx event for a fast-landing tx can arrive
    // before we register, get dropped by the subscriber, and skew measurements
    // toward whatever the slower Block subscription reports.
    let signature = *tx
        .signatures
        .first()
        .ok_or_else(|| anyhow!("signed transaction has no signature"))?;
    let submit_started = Instant::now();
    let submit_wall = SystemTime::now();
    let pending = grpc.register(signature.to_string(), submit_started, submit_wall);
    let submit_slot = grpc.current_slot();
    let signature_str = send_tx_sender.send_transaction(&tx)?;
    let send_ack_ms = submit_started.elapsed().as_secs_f64() * 1000.0;
    let returned_signature = Signature::from_str(&signature_str)
        .context("invalid signature in sendTransaction result")?;
    if returned_signature != signature {
        return Err(anyhow!(
            "RPC returned signature {} but locally-computed signature is {}",
            returned_signature,
            signature
        ));
    }
    println!("Transaction Signature: {}", signature);
    println!(
        "Triggered slot {} | submit_slot at POST {} | gap {}",
        triggered_slot,
        submit_slot,
        submit_slot.saturating_sub(triggered_slot)
    );

    let deadline = Instant::now() + CONFIRM_TIMEOUT;
    let mut landed_slot: Option<u64> = None;
    let mut landed_local_ms: Option<f64> = None;
    let mut landed_grpc_ms: Option<f64> = None;
    let mut landed_index_in_block: Option<usize> = None;
    let mut block_received_local_ms: Option<f64> = None;
    let mut error: Option<String> = None;

    while Instant::now() < deadline {
        if landed_slot.is_some() && landed_index_in_block.is_some() {
            break;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match pending.receiver.recv_timeout(remaining) {
            Ok(LandingEvent::Transaction {
                slot,
                local_received_ms,
                grpc_created_at_ms,
                err,
            }) => {
                if landed_slot.is_none() {
                    landed_slot = Some(slot);
                    landed_local_ms = Some(local_received_ms);
                    landed_grpc_ms = grpc_created_at_ms;
                }
                if let Some(e) = err {
                    error = Some(format!("transaction failed: {}", e));
                    break;
                }
            }
            Ok(LandingEvent::Block {
                slot,
                index_in_block,
                local_received_ms,
                grpc_created_at_ms,
            }) => {
                if landed_slot.is_none() {
                    landed_slot = Some(slot);
                }
                if landed_grpc_ms.is_none() {
                    landed_grpc_ms = grpc_created_at_ms;
                }
                landed_index_in_block = Some(index_in_block);
                block_received_local_ms = Some(local_received_ms);
            }
            Err(RecvTimeoutError::Timeout) => break,
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    drop(pending);

    let timed_out = landed_slot.is_none() && error.is_none();
    if timed_out {
        error = Some(format!(
            "timed out waiting for landing ({}ms)",
            CONFIRM_TIMEOUT.as_millis()
        ));
    }

    let submit_to_landed_slots = landed_slot.map(|slot| slot as i64 - submit_slot as i64);
    let same_slot_landed = landed_slot.map(|slot| slot == submit_slot).unwrap_or(false);

    Ok(RunResult {
        signature: signature.to_string(),
        triggered_slot,
        submit_slot,
        landed_slot,
        landed_index_in_block,
        submit_to_landed_slots,
        same_slot_landed,
        send_ack_ms,
        submit_to_landed_ms: landed_local_ms,
        submit_to_landed_grpc_ms: landed_grpc_ms,
        submit_to_block_received_ms: block_received_local_ms,
        priority_fee: (config.compute_unit_price_micro_lamports
            * u64::from(config.compute_unit_limit))
            / 1_000_000,
        timed_out,
        error,
    })
}

fn read_sender_keypair(path: &str, expected_pubkey: Pubkey) -> Result<Keypair> {
    let secret_key_file = fs::read_to_string(path)
        .with_context(|| format!("failed to read sender keypair: {}", path))?;
    let secret_key: Vec<u8> = serde_json::from_str(&secret_key_file)
        .with_context(|| format!("invalid keypair JSON in {}", path))?;
    let keypair =
        Keypair::try_from(secret_key.as_slice()).context("invalid sender keypair bytes")?;
    if keypair.pubkey() != expected_pubkey {
        return Err(anyhow!(
            "sender pubkey mismatch: config has {}, keypair file has {}",
            expected_pubkey,
            keypair.pubkey()
        ));
    }
    Ok(keypair)
}

fn resolve_selected_providers(
    providers: &[ProviderRuntime],
    selector: Option<&str>,
) -> Result<Vec<ProviderRuntime>> {
    match selector {
        None => providers
            .first()
            .map(|p| vec![p.clone()])
            .ok_or_else(|| anyhow!("config requires at least one [[provider]] section")),
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Err(anyhow!("--providers cannot be empty"));
            }
            if trimmed.eq_ignore_ascii_case("all") {
                return Ok(providers.to_vec());
            }

            let available = providers
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>()
                .join(", ");

            let mut seen = HashSet::new();
            let mut selected = Vec::new();
            for name in trimmed.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                let provider = providers.iter().find(|p| p.name == name).ok_or_else(|| {
                    anyhow!(
                        "provider '{}' not found, available provider names: {}",
                        name,
                        available
                    )
                })?;
                if seen.insert(provider.name.clone()) {
                    selected.push(provider.clone());
                }
            }

            if selected.is_empty() {
                return Err(anyhow!(
                    "--providers must contain at least one provider name"
                ));
            }
            Ok(selected)
        }
    }
}

fn preflight_balance_check(
    providers: &[ProviderRuntime],
    runs_per_provider: usize,
) -> Result<()> {
    let mut required_by_sender: HashMap<Pubkey, u64> = HashMap::new();
    let mut rpc_for_sender: HashMap<Pubkey, String> = HashMap::new();
    let mut providers_per_sender: HashMap<Pubkey, Vec<String>> = HashMap::new();

    for provider in providers {
        let per_run = if provider.tip_accounts.is_empty() {
            SOL_FEE_BUFFER_LAMPORTS
        } else {
            provider.tip_amount.saturating_add(SOL_FEE_BUFFER_LAMPORTS)
        };
        let total = per_run.saturating_mul(runs_per_provider as u64);
        let entry = required_by_sender.entry(provider.sender_pubkey).or_insert(0);
        *entry = entry.saturating_add(total);
        rpc_for_sender
            .entry(provider.sender_pubkey)
            .or_insert_with(|| provider.rpc_url.clone());
        providers_per_sender
            .entry(provider.sender_pubkey)
            .or_default()
            .push(provider.name.clone());
    }

    for (sender, required) in &required_by_sender {
        let rpc_url = rpc_for_sender
            .get(sender)
            .expect("rpc url recorded for sender");
        let client =
            RpcClient::new_with_commitment(rpc_url.clone(), CommitmentConfig::processed());
        let balance = client
            .get_balance(sender)
            .with_context(|| format!("failed to fetch SOL balance for sender {}", sender))?;
        let providers_using = providers_per_sender
            .get(sender)
            .map(|v| v.join(", "))
            .unwrap_or_default();
        println!(
            "Preflight: sender {} balance {} lamports (need >= {} for {} runs × providers [{}])",
            sender, balance, required, runs_per_provider, providers_using
        );
        if balance < *required {
            return Err(anyhow!(
                "insufficient SOL for sender {}: have {} lamports, need >= {} for {} runs across providers [{}]",
                sender,
                balance,
                required,
                runs_per_provider,
                providers_using
            ));
        }
    }
    Ok(())
}

fn select_tip_account(tip_accounts: &[Pubkey]) -> Option<Pubkey> {
    if tip_accounts.is_empty() {
        return None;
    }
    let mut rng = rand::thread_rng();
    let idx = rng.gen_range(0..tip_accounts.len());
    tip_accounts.get(idx).copied()
}

fn compute_averages(results: &[RunResult], total_runs: usize) -> Averages {
    if results.is_empty() {
        return Averages {
            avg_send_ack_ms: 0.0,
            avg_submit_to_landed_ms: 0.0,
            avg_submit_to_landed_grpc_ms: 0.0,
            avg_submit_to_block_received_ms: 0.0,
            avg_submit_to_landed_slots: 0.0,
            avg_landed_index_in_block: 0.0,
            avg_priority_fee: 0.0,
            max_submit_to_landed_slots: 0,
            min_submit_to_landed_slots: 0,
            same_slot_landed_count: 0,
            landed_runs: 0,
            block_seen_runs: 0,
            total_runs,
        };
    }

    let same_slot_landed_count = results.iter().filter(|r| r.same_slot_landed).count();
    let landed_slots: Vec<i64> = results
        .iter()
        .filter_map(|r| r.submit_to_landed_slots)
        .collect();
    let landed_runs = results.iter().filter(|r| r.landed_slot.is_some()).count();
    let block_seen_runs = results
        .iter()
        .filter(|r| r.landed_index_in_block.is_some())
        .count();
    let landed_indexes: Vec<f64> = results
        .iter()
        .filter_map(|r| r.landed_index_in_block.map(|v| v as f64))
        .collect();

    Averages {
        avg_send_ack_ms: results.iter().map(|r| r.send_ack_ms).sum::<f64>() / results.len() as f64,
        avg_submit_to_landed_ms: average_optional_f64(
            results.iter().map(|r| r.submit_to_landed_ms),
        ),
        avg_submit_to_landed_grpc_ms: average_optional_f64(
            results.iter().map(|r| r.submit_to_landed_grpc_ms),
        ),
        avg_submit_to_block_received_ms: average_optional_f64(
            results.iter().map(|r| r.submit_to_block_received_ms),
        ),
        avg_submit_to_landed_slots: if landed_slots.is_empty() {
            0.0
        } else {
            landed_slots.iter().sum::<i64>() as f64 / landed_slots.len() as f64
        },
        avg_landed_index_in_block: if landed_indexes.is_empty() {
            0.0
        } else {
            landed_indexes.iter().sum::<f64>() / landed_indexes.len() as f64
        },
        avg_priority_fee: results.iter().map(|r| r.priority_fee).sum::<u64>() as f64
            / results.len() as f64,
        max_submit_to_landed_slots: landed_slots.iter().copied().max().unwrap_or(0),
        min_submit_to_landed_slots: landed_slots.iter().copied().min().unwrap_or(0),
        same_slot_landed_count,
        landed_runs,
        block_seen_runs,
        total_runs,
    }
}

fn compute_percentiles(results: &[RunResult]) -> Percentiles {
    Percentiles {
        p90_send_ack_ms: p90_f64(results.iter().map(|r| r.send_ack_ms).collect()),
        p90_submit_to_landed_ms: p90_f64(
            results
                .iter()
                .filter_map(|r| r.submit_to_landed_ms)
                .collect(),
        ),
        p90_submit_to_landed_grpc_ms: p90_f64(
            results
                .iter()
                .filter_map(|r| r.submit_to_landed_grpc_ms)
                .collect(),
        ),
        p90_submit_to_block_received_ms: p90_f64(
            results
                .iter()
                .filter_map(|r| r.submit_to_block_received_ms)
                .collect(),
        ),
        p90_submit_to_landed_slots: p90_i64(
            results
                .iter()
                .filter_map(|r| r.submit_to_landed_slots)
                .collect(),
        ),
        p90_landed_index_in_block: p90_f64(
            results
                .iter()
                .filter_map(|r| r.landed_index_in_block.map(|v| v as f64))
                .collect(),
        ),
    }
}

fn p90_f64(mut values: Vec<f64>) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = ((values.len() as f64 * 0.9).ceil() as usize).saturating_sub(1);
    values[idx]
}

fn p90_i64(values: Vec<i64>) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    p90_f64(values.into_iter().map(|v| v as f64).collect())
}

fn average_optional_f64<I>(iter: I) -> f64
where
    I: Iterator<Item = Option<f64>>,
{
    let values: Vec<f64> = iter.flatten().collect();
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

fn timestamp_for_filename() -> String {
    chrono::Local::now().format("%Y%m%d_%H%M%S").to_string()
}

fn derive_json_report_filename(markdown_filename: &str) -> String {
    let path = Path::new(markdown_filename);
    if let Some(stem) = path.file_stem().and_then(|value| value.to_str()) {
        let mut json_path = path.to_path_buf();
        json_path.set_file_name(format!("{}.json", stem));
        return json_path.to_string_lossy().into_owned();
    }
    format!("{}.json", markdown_filename)
}

fn build_multi_provider_output_data<'a>(
    benchmarks: &'a [ProviderBenchmark],
    performance: &HashMap<String, ProviderPerformance>,
    loaded: &LoadedConfig,
    runs: usize,
    selected_providers: &[String],
) -> MultiProviderOutputData<'a> {
    let mut providers = Vec::with_capacity(benchmarks.len());
    for benchmark in benchmarks {
        let provider_performance = performance
            .get(&benchmark.provider_name)
            .copied()
            .unwrap_or(ProviderPerformance {
                success_landing_ratio_pct: 0.0,
                performance_rate_pct: 0.0,
            });
        providers.push(ProviderComparisonOutput {
            provider_name: &benchmark.provider_name,
            sender_pubkey: benchmark.sender_pubkey.to_string(),
            success_landing_ratio_pct: provider_performance.success_landing_ratio_pct,
            performance_rate_pct: provider_performance.performance_rate_pct,
            averages: &benchmark.averages,
            percentiles: &benchmark.percentiles,
            results: &benchmark.results,
        });
    }

    MultiProviderOutputData {
        generated_at: chrono::Local::now().to_rfc3339(),
        sender_pubkey: format_sender_summary(benchmarks, loaded.default_sender_pubkey),
        receiver_pubkey: loaded.receiver_pubkey.to_string(),
        runs_per_provider: runs,
        selected_providers: selected_providers.to_vec(),
        providers,
    }
}

fn normalize_lower_is_better(best: Option<f64>, value: Option<f64>) -> f64 {
    match (best, value) {
        (None, _) => 100.0,
        (Some(_), None) => 0.0,
        (Some(best_value), Some(value)) => {
            if best_value <= 0.0 && value <= 0.0 {
                100.0
            } else if best_value <= 0.0 || value <= 0.0 {
                0.0
            } else {
                ((best_value / value) * 100.0).clamp(0.0, 100.0)
            }
        }
    }
}

fn normalize_higher_is_better(best: f64, value: f64) -> f64 {
    if best <= 0.0 {
        100.0
    } else {
        ((value / best) * 100.0).clamp(0.0, 100.0)
    }
}

fn compute_provider_performance(
    benchmarks: &[ProviderBenchmark],
) -> HashMap<String, ProviderPerformance> {
    let best_avg_landed_ms = benchmarks
        .iter()
        .filter(|bench| bench.averages.landed_runs > 0)
        .map(|bench| bench.averages.avg_submit_to_landed_ms)
        .min_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let best_avg_landed_slots = benchmarks
        .iter()
        .filter(|bench| bench.averages.landed_runs > 0)
        .map(|bench| bench.averages.avg_submit_to_landed_slots)
        .min_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let best_same_slot_count = benchmarks
        .iter()
        .map(|bench| bench.averages.same_slot_landed_count as f64)
        .fold(0.0, f64::max);
    let best_success_ratio = benchmarks
        .iter()
        .map(|bench| {
            if bench.averages.total_runs == 0 {
                0.0
            } else {
                (bench.averages.landed_runs as f64 / bench.averages.total_runs as f64) * 100.0
            }
        })
        .fold(0.0, f64::max);

    let mut performance = HashMap::with_capacity(benchmarks.len());
    for benchmark in benchmarks {
        let avg_landed_ms = if benchmark.averages.landed_runs > 0 {
            Some(benchmark.averages.avg_submit_to_landed_ms)
        } else {
            None
        };
        let avg_landed_slots = if benchmark.averages.landed_runs > 0 {
            Some(benchmark.averages.avg_submit_to_landed_slots)
        } else {
            None
        };
        let same_slot_count = benchmark.averages.same_slot_landed_count as f64;
        let success_ratio = if benchmark.averages.total_runs == 0 {
            0.0
        } else {
            (benchmark.averages.landed_runs as f64 / benchmark.averages.total_runs as f64) * 100.0
        };

        let landed_ms_score = normalize_lower_is_better(best_avg_landed_ms, avg_landed_ms);
        let landed_slots_score = normalize_lower_is_better(best_avg_landed_slots, avg_landed_slots);
        let same_slot_score = normalize_higher_is_better(best_same_slot_count, same_slot_count);
        let success_ratio_score = normalize_higher_is_better(best_success_ratio, success_ratio);
        let performance_rate_pct =
            (landed_ms_score + landed_slots_score + same_slot_score + success_ratio_score) / 4.0;

        performance.insert(
            benchmark.provider_name.clone(),
            ProviderPerformance {
                success_landing_ratio_pct: success_ratio,
                performance_rate_pct,
            },
        );
    }

    performance
}

fn render_markdown_report(
    benchmarks: &[ProviderBenchmark],
    performance: &HashMap<String, ProviderPerformance>,
    default_sender: Pubkey,
    receiver_pubkey: Pubkey,
    runs: usize,
    selected_providers: &[String],
) -> String {
    let mut out = String::new();
    out.push_str("# Multi-provider Benchmark Comparison\n\n");
    out.push_str(&format!(
        "- Generated: `{}`\n",
        chrono::Local::now().to_rfc3339()
    ));
    out.push_str(&format!(
        "- Sender(s): `{}`\n",
        format_sender_summary(benchmarks, default_sender)
    ));
    out.push_str(&format!("- Receiver: `{}`\n", receiver_pubkey));
    out.push_str(&format!("- Runs per provider: `{}`\n", runs));
    out.push_str(&format!(
        "- Selected providers: `{}`\n\n",
        selected_providers.join(", ")
    ));
    out.push_str("| Provider | Sender | Avg Ack ms | P90 Ack ms | Avg Landed ms | P90 Landed ms | Avg gRPC Landed ms | P90 gRPC Landed ms | Avg Block ms | P90 Block ms | Avg Landed slots | P90 Landed slots | Avg Idx-in-Block | P90 Idx-in-Block | Avg Priority Fee | Max Slots | Min Slots | Same-slot landed | Landed runs | Block seen | Total runs | Success ratio % | Performance rate % |\n");
    out.push_str(
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n",
    );

    for benchmark in benchmarks {
        let avg = &benchmark.averages;
        let p90 = &benchmark.percentiles;
        let provider_performance = performance
            .get(&benchmark.provider_name)
            .copied()
            .unwrap_or(ProviderPerformance {
                success_landing_ratio_pct: 0.0,
                performance_rate_pct: 0.0,
            });
        out.push_str(&format!(
            "| {} | `{}` | {:.3} | {:.3} | {:.3} | {:.3} | {:.3} | {:.3} | {:.3} | {:.3} | {:.3} | {:.3} | {:.2} | {:.2} | {:.3} | {} | {} | {} | {} | {} | {} | {:.2} | {:.2} |\n",
            benchmark.provider_name,
            benchmark.sender_pubkey,
            avg.avg_send_ack_ms,
            p90.p90_send_ack_ms,
            avg.avg_submit_to_landed_ms,
            p90.p90_submit_to_landed_ms,
            avg.avg_submit_to_landed_grpc_ms,
            p90.p90_submit_to_landed_grpc_ms,
            avg.avg_submit_to_block_received_ms,
            p90.p90_submit_to_block_received_ms,
            avg.avg_submit_to_landed_slots,
            p90.p90_submit_to_landed_slots,
            avg.avg_landed_index_in_block,
            p90.p90_landed_index_in_block,
            avg.avg_priority_fee,
            avg.max_submit_to_landed_slots,
            avg.min_submit_to_landed_slots,
            avg.same_slot_landed_count,
            avg.landed_runs,
            avg.block_seen_runs,
            avg.total_runs,
            provider_performance.success_landing_ratio_pct,
            provider_performance.performance_rate_pct
        ));
    }

    out
}

fn format_sender_summary(benchmarks: &[ProviderBenchmark], default_sender: Pubkey) -> String {
    let mut senders = benchmarks
        .iter()
        .map(|benchmark| benchmark.sender_pubkey.to_string())
        .collect::<Vec<_>>();
    senders.sort();
    senders.dedup();
    match senders.len() {
        0 => default_sender.to_string(),
        1 => senders[0].clone(),
        _ => format!("multiple ({})", senders.join(", ")),
    }
}

fn panic_payload_to_string(payload: Box<dyn Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return format!("provider worker panicked: {}", message);
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return format!("provider worker panicked: {}", message);
    }
    "provider worker panicked".to_string()
}
