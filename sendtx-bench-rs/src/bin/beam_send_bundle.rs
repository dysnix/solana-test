use std::fs;
use std::str::FromStr;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use clap::Parser;
use reqwest::blocking::Client as HttpClient;
use reqwest::header::CONTENT_TYPE;
use serde::Deserialize;
use serde_json::{Value, json};
use solana_client::rpc_client::RpcClient;
use solana_commitment_config::CommitmentConfig;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_sdk::hash::Hash;
use solana_sdk::instruction::Instruction;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::transaction::Transaction;
use solana_system_interface::instruction as system_instruction;

const MIN_BUNDLE_SIZE: usize = 2;
const MAX_BUNDLE_SIZE: usize = 4;
const FEE_BUFFER_LAMPORTS_PER_TX: u64 = 50_000;
const MEMO_PROGRAM_ID: &str = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

#[derive(Debug, Parser)]
#[command(
    name = "beam-send-bundle",
    about = "Send a small transaction bundle through Beam's JSON-RPC sendBundle method"
)]
struct Args {
    /// Benchmark TOML config to reuse for RPC, sender, Beam URL, and tip settings.
    #[arg(long, default_value = "config.toml")]
    config: String,

    /// Provider section name. Defaults to the first [[provider]] section.
    #[arg(long)]
    provider: Option<String>,

    /// Number of transactions to include. Beam accepts at most four; this tester requires two.
    #[arg(long, default_value_t = MIN_BUNDLE_SIZE)]
    bundle_size: usize,

    /// Override the first tip account from the selected provider configuration.
    #[arg(long)]
    tip_account: Option<String>,

    /// Override the configured tip amount in lamports.
    #[arg(long)]
    tip_amount: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct BenchConfigFile {
    #[serde(default)]
    global: Vec<GlobalConfig>,
    #[serde(default)]
    sender: Vec<SenderConfig>,
    #[serde(default)]
    provider: Vec<ProviderConfig>,
}

#[derive(Debug, Deserialize)]
struct GlobalConfig {
    tip_amount: u64,
    compute_unit_limit: u32,
    compute_unit_price_micro_lamports: u64,
    rpc_url: String,
    send_tx_rpc_url: String,
}

#[derive(Debug, Deserialize)]
struct SenderConfig {
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

struct RuntimeConfig {
    provider_name: String,
    rpc_url: String,
    beam_url: String,
    sender: Keypair,
    tip_account: Pubkey,
    tip_amount: u64,
    compute_unit_limit: u32,
    compute_unit_price_micro_lamports: u64,
}

fn main() -> Result<()> {
    let args = Args::parse();
    validate_bundle_size(args.bundle_size)?;
    let config = load_config(&args)?;

    let rpc = RpcClient::new_with_commitment(config.rpc_url.clone(), CommitmentConfig::processed());
    let sender_pubkey = config.sender.pubkey();
    let balance = rpc
        .get_balance(&sender_pubkey)
        .with_context(|| format!("failed to fetch balance for sender {sender_pubkey}"))?;
    let required_balance = config
        .tip_amount
        .saturating_add(FEE_BUFFER_LAMPORTS_PER_TX.saturating_mul(args.bundle_size as u64));
    if balance < required_balance {
        return Err(anyhow!(
            "insufficient SOL for sender {}: have {} lamports, need at least {}",
            sender_pubkey,
            balance,
            required_balance
        ));
    }

    let recent_blockhash = rpc
        .get_latest_blockhash()
        .context("failed to fetch recent blockhash")?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before Unix epoch")?
        .as_nanos();
    let transactions = build_bundle(
        &config.sender,
        config.tip_account,
        config.tip_amount,
        config.compute_unit_limit,
        config.compute_unit_price_micro_lamports,
        args.bundle_size,
        nonce,
        recent_blockhash,
    )?;

    println!("Provider config: {}", config.provider_name);
    println!("Sender: {sender_pubkey}");
    println!("Bundle transactions: {}", transactions.len());
    println!(
        "Final transaction tip: {} lamports to {}",
        config.tip_amount, config.tip_account
    );
    for (index, tx) in transactions.iter().enumerate() {
        let signature = tx
            .signatures
            .first()
            .ok_or_else(|| anyhow!("transaction {} has no signature", index + 1))?;
        println!(
            "Transaction {}: {}{}",
            index + 1,
            signature,
            if index + 1 == transactions.len() {
                " (contains tip transfer)"
            } else {
                ""
            }
        );
    }

    let started = Instant::now();
    let result = send_bundle(&config.beam_url, &transactions, nonce)?;
    println!(
        "Beam accepted sendBundle in {:.3} ms",
        started.elapsed().as_secs_f64() * 1_000.0
    );
    println!("Result: {}", serde_json::to_string_pretty(&result)?);

    Ok(())
}

fn validate_bundle_size(bundle_size: usize) -> Result<()> {
    if !(MIN_BUNDLE_SIZE..=MAX_BUNDLE_SIZE).contains(&bundle_size) {
        return Err(anyhow!(
            "--bundle-size must be between {MIN_BUNDLE_SIZE} and {MAX_BUNDLE_SIZE}"
        ));
    }
    Ok(())
}

fn load_config(args: &Args) -> Result<RuntimeConfig> {
    let config_text = fs::read_to_string(&args.config)
        .with_context(|| format!("failed to read config file: {}", args.config))?;
    let config_file: BenchConfigFile =
        toml::from_str(&config_text).context("invalid config TOML format")?;
    let global = config_file
        .global
        .first()
        .ok_or_else(|| anyhow!("config requires at least one [[global]] section"))?;
    let default_sender = config_file
        .sender
        .first()
        .ok_or_else(|| anyhow!("config requires at least one [[sender]] section"))?;
    let provider = select_provider(&config_file.provider, args.provider.as_deref())?;

    if provider.sender_pubkey.is_some() != provider.sender_private_key.is_some() {
        return Err(anyhow!(
            "provider '{}' must set both sender_pubkey and sender_private_key together",
            provider.name
        ));
    }
    let sender_pubkey_text = provider
        .sender_pubkey
        .as_deref()
        .unwrap_or(&default_sender.pubkey);
    let sender_pubkey = Pubkey::from_str(sender_pubkey_text)
        .with_context(|| format!("invalid sender pubkey for provider '{}'", provider.name))?;
    let sender_keypair_path = provider
        .sender_private_key
        .as_deref()
        .unwrap_or(&default_sender.private_key);
    let sender = read_keypair(sender_keypair_path, sender_pubkey)?;

    let tip_account_text = args
        .tip_account
        .as_deref()
        .or_else(|| provider.tip_accounts.first().map(String::as_str))
        .ok_or_else(|| {
            anyhow!(
                "provider '{}' has no tip_accounts; set one in the config or pass --tip-account",
                provider.name
            )
        })?;
    let tip_account = Pubkey::from_str(tip_account_text).with_context(|| {
        format!(
            "invalid tip account '{}' for provider '{}'",
            tip_account_text, provider.name
        )
    })?;
    let tip_amount = args
        .tip_amount
        .or(provider.tip_amount)
        .unwrap_or(global.tip_amount);
    if tip_amount == 0 {
        return Err(anyhow!("tip amount must be greater than zero"));
    }

    Ok(RuntimeConfig {
        provider_name: provider.name.clone(),
        rpc_url: provider
            .rpc_url
            .clone()
            .unwrap_or_else(|| global.rpc_url.clone()),
        beam_url: provider
            .send_tx_rpc_url
            .clone()
            .unwrap_or_else(|| global.send_tx_rpc_url.clone()),
        sender,
        tip_account,
        tip_amount,
        compute_unit_limit: provider
            .compute_unit_limit
            .unwrap_or(global.compute_unit_limit),
        compute_unit_price_micro_lamports: provider
            .compute_unit_price_micro_lamports
            .unwrap_or(global.compute_unit_price_micro_lamports),
    })
}

fn select_provider<'a>(
    providers: &'a [ProviderConfig],
    selected_name: Option<&str>,
) -> Result<&'a ProviderConfig> {
    if providers.is_empty() {
        return Err(anyhow!("config requires at least one [[provider]] section"));
    }
    match selected_name {
        Some(name) => providers
            .iter()
            .find(|provider| provider.name == name)
            .ok_or_else(|| {
                anyhow!(
                    "provider '{}' not found; available providers: {}",
                    name,
                    providers
                        .iter()
                        .map(|provider| provider.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            }),
        None => Ok(&providers[0]),
    }
}

fn read_keypair(path: &str, expected_pubkey: Pubkey) -> Result<Keypair> {
    let keypair_text = fs::read_to_string(path)
        .with_context(|| format!("failed to read sender keypair: {path}"))?;
    let keypair_bytes: Vec<u8> = serde_json::from_str(&keypair_text)
        .with_context(|| format!("invalid keypair JSON in {path}"))?;
    let keypair =
        Keypair::try_from(keypair_bytes.as_slice()).context("invalid sender keypair bytes")?;
    if keypair.pubkey() != expected_pubkey {
        return Err(anyhow!(
            "sender pubkey mismatch: config has {}, keypair file has {}",
            expected_pubkey,
            keypair.pubkey()
        ));
    }
    Ok(keypair)
}

#[allow(clippy::too_many_arguments)]
fn build_bundle(
    sender: &Keypair,
    tip_account: Pubkey,
    tip_amount: u64,
    compute_unit_limit: u32,
    compute_unit_price_micro_lamports: u64,
    bundle_size: usize,
    nonce: u128,
    recent_blockhash: Hash,
) -> Result<Vec<Transaction>> {
    validate_bundle_size(bundle_size)?;
    let sender_pubkey = sender.pubkey();
    let instruction_sets = build_bundle_instructions(
        sender_pubkey,
        tip_account,
        tip_amount,
        compute_unit_limit,
        compute_unit_price_micro_lamports,
        bundle_size,
        nonce,
    )?;
    Ok(instruction_sets
        .iter()
        .map(|instructions| {
            Transaction::new_signed_with_payer(
                instructions,
                Some(&sender_pubkey),
                &[sender],
                recent_blockhash,
            )
        })
        .collect())
}

#[allow(clippy::too_many_arguments)]
fn build_bundle_instructions(
    sender: Pubkey,
    tip_account: Pubkey,
    tip_amount: u64,
    compute_unit_limit: u32,
    compute_unit_price_micro_lamports: u64,
    bundle_size: usize,
    nonce: u128,
) -> Result<Vec<Vec<Instruction>>> {
    validate_bundle_size(bundle_size)?;
    let memo_program_id = Pubkey::from_str(MEMO_PROGRAM_ID).expect("valid memo program id");
    let mut bundle = Vec::with_capacity(bundle_size);

    for index in 0..bundle_size {
        let memo = format!("beam-send-bundle:{nonce}:{}", index + 1);
        let mut instructions = vec![
            ComputeBudgetInstruction::set_compute_unit_limit(compute_unit_limit),
            ComputeBudgetInstruction::set_compute_unit_price(compute_unit_price_micro_lamports),
            Instruction::new_with_bytes(memo_program_id, memo.as_bytes(), Vec::new()),
        ];
        if index + 1 == bundle_size {
            instructions.push(system_instruction::transfer(
                &sender,
                &tip_account,
                tip_amount,
            ));
        }
        bundle.push(instructions);
    }

    Ok(bundle)
}

fn send_bundle(beam_url: &str, transactions: &[Transaction], request_id: u128) -> Result<Value> {
    let encoded_transactions = transactions
        .iter()
        .map(|transaction| {
            bincode::serialize(transaction)
                .map(|bytes| BASE64_STANDARD.encode(bytes))
                .context("failed to serialize bundle transaction")
        })
        .collect::<Result<Vec<_>>>()?;
    let payload = json!({
        "jsonrpc": "2.0",
        "id": request_id.to_string(),
        "method": "sendBundle",
        "params": [
            encoded_transactions,
            { "encoding": "base64" }
        ]
    });
    let client = HttpClient::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .context("failed to build HTTP client")?;
    let response = client
        .post(beam_url)
        .header(CONTENT_TYPE, "application/json")
        .json(&payload)
        .send()
        .map_err(|error| anyhow!("Beam sendBundle request failed: {}", error.without_url()))?;
    let status = response.status();
    let body_text = response
        .text()
        .context("failed to read Beam sendBundle response body")?;
    if !status.is_success() {
        return Err(anyhow!(
            "Beam sendBundle HTTP error: {} body={}",
            status,
            body_text
        ));
    }
    let body: Value = serde_json::from_str(&body_text).context("invalid Beam JSON-RPC response")?;
    if let Some(error) = body.get("error") {
        return Err(anyhow!("Beam sendBundle RPC error: {error}"));
    }
    body.get("result")
        .cloned()
        .ok_or_else(|| anyhow!("Beam sendBundle response has no result: {body_text}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_size_requires_at_least_two_transactions() {
        assert!(validate_bundle_size(1).is_err());
        assert!(validate_bundle_size(2).is_ok());
        assert!(validate_bundle_size(4).is_ok());
        assert!(validate_bundle_size(5).is_err());
    }

    #[test]
    fn only_final_transaction_contains_tip_account() {
        let sender = Pubkey::new_unique();
        let tip_account = Pubkey::new_unique();
        let bundle = build_bundle_instructions(sender, tip_account, 1_000, 100_000, 1, 3, 42)
            .expect("bundle instructions");
        let expected_tip_instruction = system_instruction::transfer(&sender, &tip_account, 1_000);

        for instructions in &bundle[..bundle.len() - 1] {
            assert!(!instructions.contains(&expected_tip_instruction));
        }
        let final_instructions = bundle.last().expect("final transaction instructions");
        assert_eq!(final_instructions.last(), Some(&expected_tip_instruction));
    }
}
