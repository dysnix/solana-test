use std::fs;
use std::str::FromStr;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use clap::Parser;
use reqwest::blocking::Client as HttpClient;
use reqwest::header::{CONNECTION, CONTENT_TYPE};
use serde::Serialize;
use serde_json::{Value, json};
use solana_client::rpc_client::RpcClient;
use solana_client::rpc_config::{RpcSendTransactionConfig, UiTransactionEncoding};
use solana_commitment_config::CommitmentConfig;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signature, Signer};
use solana_sdk::transaction::Transaction;
use solana_system_interface::instruction as system_instruction;
use spl_associated_token_account::get_associated_token_address;
use spl_token::instruction::transfer_checked;

const USDT_MINT_STR: &str = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const DEFAULT_PRIORITY_FEE: u64 = 10_000;
const DEFAULT_TIP_AMOUNT: u64 = 1_000_000;
const SOL_FEE_BUFFER_LAMPORTS: u64 = 50_000;
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Parser, Debug)]
#[command(about = "Run Solana token transfer benchmark")]
struct Args {
    #[arg(long, default_value_t = 1)]
    runs: usize,
    #[arg(long)]
    output: Option<String>,
}

#[derive(Clone)]
struct Config {
    rpc_url: String,
    send_tx_rpc_url: String,
    receiver_pubkey: Pubkey,
    tip_account: Option<Pubkey>,
    tip_amount: u64,
}

#[derive(Debug, Serialize)]
struct RunResult {
    pre_slot: u64,
    confirmed_slot: u64,
    slot_diff: i64,
    time_diff: f64,
    priority_fee: u64,
}

#[derive(Debug, Serialize)]
struct Averages {
    avg_slot_diff: f64,
    avg_time_diff: f64,
    avg_priority_fee: f64,
    max_slot_diff: i64,
    min_slot_diff: i64,
    successful_runs: usize,
    total_runs: usize,
}

#[derive(Debug, Serialize)]
struct OutputData {
    results: Vec<RunResult>,
    averages: Averages,
}

struct PersistentRpcSender {
    rpc_url: String,
    request_id: u64,
    client: HttpClient,
}

impl PersistentRpcSender {
    fn new(rpc_url: String) -> Result<Self> {
        let client = HttpClient::builder()
            .pool_max_idle_per_host(2)
            .pool_idle_timeout(Duration::from_secs(90))
            .timeout(Duration::from_secs(10))
            .build()
            .context("failed to build persistent HTTP client")?;

        Ok(Self {
            rpc_url,
            request_id: 0,
            client,
        })
    }

    fn send_transaction(&mut self, tx: &Transaction) -> Result<String> {
        self.request_id += 1;
        let encoded_tx = BASE64_STANDARD
            .encode(bincode::serialize(tx).context("failed to serialize transaction")?);

        let payload = json!({
            "jsonrpc": "2.0",
            "id": self.request_id,
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
    dotenvy::dotenv().ok();
    let args = Args::parse();
    let config = Config::from_env()?;
    let mut send_tx_sender = PersistentRpcSender::new(config.send_tx_rpc_url.clone())?;

    let mut results = Vec::new();
    for i in 0..args.runs {
        println!("\nRun {}/{}", i + 1, args.runs);
        println!("\nGetting priority fee estimate...");
        let priority_fee = DEFAULT_PRIORITY_FEE;
        println!("Priority fee: {}", priority_fee);

        match run_transfer(priority_fee, &config, &mut send_tx_sender) {
            Ok(Some(result)) => {
                println!("{}", serde_json::to_string(&result)?);
                results.push(result);
            }
            Ok(None) => {
                println!("Run failed, skipping...");
            }
            Err(err) => return Err(err),
        }

        if i + 1 < args.runs {
            thread::sleep(Duration::from_secs(1));
        }
    }

    let averages = compute_averages(&results, args.runs);
    let output_data = OutputData { results, averages };
    let filename = args
        .output
        .unwrap_or_else(|| format!("transfer_results_{}.json", timestamp_for_filename()));

    fs::write(&filename, serde_json::to_string_pretty(&output_data)?)
        .with_context(|| format!("failed to write output file: {}", filename))?;

    println!("\nResults saved to {}", filename);
    println!("\nFinal Results:");
    println!("{}", serde_json::to_string_pretty(&output_data)?);

    Ok(())
}

impl Config {
    fn from_env() -> Result<Self> {
        let api_key = std::env::var("API_KEY").ok();
        let rpc_url = expand_api_key(
            std::env::var("RPC_URL")
                .ok()
                .unwrap_or_else(|| default_rpc_url(api_key.as_deref())),
            api_key.as_deref(),
        );
        let send_tx_rpc_url = expand_api_key(
            std::env::var("SEND_TX_RPC_URL")
                .ok()
                .unwrap_or_else(|| default_rpc_url(api_key.as_deref())),
            api_key.as_deref(),
        );

        let receiver_pubkey = Pubkey::from_str(
            &std::env::var("RECEIVER_PUBLIC_KEY")
                .context("RECEIVER_PUBLIC_KEY is required in environment")?,
        )
        .context("invalid RECEIVER_PUBLIC_KEY")?;

        let tip_account = match std::env::var("TIP_ACCOUNT") {
            Ok(value) if !value.trim().is_empty() => {
                Some(Pubkey::from_str(&value).context("invalid TIP_ACCOUNT")?)
            }
            _ => None,
        };

        let tip_amount = match std::env::var("TIP_AMOUNT") {
            Ok(value) => value
                .parse::<u64>()
                .context("TIP_AMOUNT must be a positive integer lamports value")?,
            Err(_) => DEFAULT_TIP_AMOUNT,
        };

        Ok(Self {
            rpc_url,
            send_tx_rpc_url,
            receiver_pubkey,
            tip_account,
            tip_amount,
        })
    }
}

fn run_transfer(
    priority_fee: u64,
    config: &Config,
    send_tx_sender: &mut PersistentRpcSender,
) -> Result<Option<RunResult>> {
    let client =
        RpcClient::new_with_commitment(config.rpc_url.clone(), CommitmentConfig::confirmed());

    let sender = read_sender_keypair()?;
    let sender_pubkey = sender.pubkey();
    let usdt_mint = Pubkey::from_str(USDT_MINT_STR).context("invalid USDT mint")?;
    let sender_usdt_acc = get_associated_token_address(&sender_pubkey, &usdt_mint);
    let receiver_usdt_acc = get_associated_token_address(&config.receiver_pubkey, &usdt_mint);

    let amount: u64 = 10_000;

    println!("\nChecking sender's USDT balance...");
    let sender_usdt_balance = client
        .get_token_account_balance(&sender_usdt_acc)
        .context("failed to fetch sender USDT token account balance")?;
    println!("Sender's USDT balance: {}", sender_usdt_balance.amount);

    let sender_usdt_amount = sender_usdt_balance
        .amount
        .parse::<u64>()
        .context("invalid sender USDT amount returned by RPC")?;
    if sender_usdt_amount < amount {
        return Err(anyhow!(
            "insufficient USDT balance: have {}, need {}",
            sender_usdt_amount,
            amount
        ));
    }

    println!("\nChecking sender's SOL balance...");
    let sender_sol_balance_lamports = client
        .get_balance(&sender_pubkey)
        .context("failed to fetch sender SOL balance")?;
    let sender_sol_balance = sender_sol_balance_lamports as f64 / 1_000_000_000f64;
    let required_lamports = (if config.tip_account.is_some() {
        config.tip_amount
    } else {
        0
    }) + SOL_FEE_BUFFER_LAMPORTS;
    let required_sol = required_lamports as f64 / 1_000_000_000f64;
    println!(
        "Sender SOL balance: {} lamports ({:.9} SOL)",
        sender_sol_balance_lamports, sender_sol_balance
    );
    println!(
        "Estimated SOL needed: {} lamports ({:.9} SOL)",
        required_lamports, required_sol
    );
    if sender_sol_balance_lamports < required_lamports {
        return Err(anyhow!(
            "insufficient SOL balance: have {} lamports, need at least {} lamports",
            sender_sol_balance_lamports,
            required_lamports
        ));
    }

    println!("\nCreating transfer transaction...");
    println!("From: {}", sender_usdt_acc);
    println!("To: {}", receiver_usdt_acc);
    println!("Amount: {}", amount);
    println!("Priority fee: {}", priority_fee);

    let mut ixs = Vec::new();
    ixs.push(ComputeBudgetInstruction::set_compute_unit_price(
        priority_fee,
    ));
    ixs.push(
        transfer_checked(
            &spl_token::id(),
            &sender_usdt_acc,
            &usdt_mint,
            &receiver_usdt_acc,
            &sender_pubkey,
            &[],
            amount,
            6,
        )
        .context("failed to build transfer_checked instruction")?,
    );
    if let Some(tip_account) = config.tip_account {
        ixs.push(system_instruction::transfer(
            &sender_pubkey,
            &tip_account,
            config.tip_amount,
        ));
    }

    let pre_slot = client.get_slot().context("failed to fetch current slot")?;
    println!("Current slot: {}", pre_slot);

    println!("Getting recent blockhash...");
    let recent_blockhash = client
        .get_latest_blockhash()
        .context("failed to get latest blockhash")?;
    println!("Recent blockhash: {}", recent_blockhash);

    let tx = Transaction::new_signed_with_payer(
        &ixs,
        Some(&sender_pubkey),
        &[&sender],
        recent_blockhash,
    );

    println!("\nSending transaction...");
    let signature_str = send_tx_sender.send_transaction(&tx)?;
    let signature = Signature::from_str(&signature_str)
        .context("invalid signature in sendTransaction result")?;
    println!("Transaction Signature: {}", signature);
    let sent_time = unix_timestamp_f64()?;

    println!("Waiting for confirmation...");
    let deadline = Instant::now() + CONFIRM_TIMEOUT;
    let mut confirmed_slot: Option<u64> = None;
    let mut confirmed_time: Option<f64> = None;

    while Instant::now() < deadline {
        let status_response = client
            .get_signature_statuses(&[signature])
            .context("failed to fetch signature status")?;

        if let Some(Some(status)) = status_response.value.first() {
            if status.err.is_some() {
                println!("Transaction failed: {:?}", status.err);
                return Ok(None);
            }

            let confirmation_state = format!("{:?}", status.confirmation_status).to_lowercase();
            if confirmation_state.contains("confirmed") {
                confirmed_slot = Some(status.slot);
                confirmed_time = Some(unix_timestamp_f64()?);
                println!("Transaction confirmed! {:?}", status.confirmation_status);
                break;
            }
        }
        thread::sleep(POLL_INTERVAL);
    }

    let (confirmed_slot, confirmed_time) = match (confirmed_slot, confirmed_time) {
        (Some(slot), Some(ts)) => (slot, ts),
        _ => {
            println!(
                "Timed out waiting for confirmation ({}ms)",
                CONFIRM_TIMEOUT.as_millis()
            );
            return Ok(None);
        }
    };

    let slot_diff = confirmed_slot as i64 - pre_slot as i64;
    let time_diff = confirmed_time - sent_time;
    Ok(Some(RunResult {
        pre_slot,
        confirmed_slot,
        slot_diff,
        time_diff,
        priority_fee,
    }))
}

fn read_sender_keypair() -> Result<Keypair> {
    let secret_key_file = fs::read_to_string("sender_pk.json")
        .context("failed to read sender_pk.json from current directory")?;
    let secret_key: Vec<u8> =
        serde_json::from_str(&secret_key_file).context("invalid sender_pk.json format")?;
    Keypair::try_from(secret_key.as_slice()).context("invalid sender keypair bytes")
}

fn compute_averages(results: &[RunResult], total_runs: usize) -> Averages {
    if results.is_empty() {
        return Averages {
            avg_slot_diff: 0.0,
            avg_time_diff: 0.0,
            avg_priority_fee: 0.0,
            max_slot_diff: 0,
            min_slot_diff: 0,
            successful_runs: 0,
            total_runs,
        };
    }

    let total_slot_diff: i64 = results.iter().map(|r| r.slot_diff).sum();
    let total_time_diff: f64 = results.iter().map(|r| r.time_diff).sum();
    let total_priority_fee: u64 = results.iter().map(|r| r.priority_fee).sum();
    let max_slot_diff = results.iter().map(|r| r.slot_diff).max().unwrap_or(0);
    let min_slot_diff = results.iter().map(|r| r.slot_diff).min().unwrap_or(0);

    Averages {
        avg_slot_diff: total_slot_diff as f64 / results.len() as f64,
        avg_time_diff: total_time_diff / results.len() as f64,
        avg_priority_fee: total_priority_fee as f64 / results.len() as f64,
        max_slot_diff,
        min_slot_diff,
        successful_runs: results.len(),
        total_runs,
    }
}

fn timestamp_for_filename() -> String {
    chrono::Local::now().format("%Y%m%d_%H%M%S").to_string()
}

fn unix_timestamp_f64() -> Result<f64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before unix epoch")?
        .as_secs_f64())
}

fn default_rpc_url(api_key: Option<&str>) -> String {
    format!(
        "https://solana-rpc.rpcfast.com/?api_key={}",
        api_key.unwrap_or_default()
    )
}

fn expand_api_key(value: String, api_key: Option<&str>) -> String {
    value.replace("${API_KEY}", api_key.unwrap_or_default())
}
