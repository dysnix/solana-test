use std::fs;
use std::path::Path;
use std::str::FromStr;

use anyhow::{Context, Result, anyhow};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

pub fn load_provider_sender(
    config_path: &str,
    provider_name: &str,
    private_key_path: Option<&str>,
    configured_pubkey: Option<&str>,
) -> Result<(String, Keypair)> {
    let private_key_path = private_key_path
        .map(str::to_owned)
        .unwrap_or_else(|| format!("wallets/{provider_name}.json"));
    let path = Path::new(config_path)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(private_key_path);
    let path = path.to_string_lossy().into_owned();
    let sender =
        read_sender_keypair(&path).with_context(|| format!("provider '{provider_name}'"))?;
    if let Some(configured) = configured_pubkey {
        let expected = Pubkey::from_str(configured)
            .with_context(|| format!("invalid sender_pubkey at provider '{provider_name}'"))?;
        if expected != sender.pubkey() {
            return Err(anyhow!(
                "sender_pubkey at provider '{provider_name}' does not match keypair {path}"
            ));
        }
    }
    Ok((path, sender))
}

pub fn read_sender_keypair(path: &str) -> Result<Keypair> {
    let secret_key_file = fs::read_to_string(path)
        .with_context(|| format!("failed to read sender keypair: {path}"))?;
    let secret_key: Vec<u8> = serde_json::from_str(&secret_key_file)
        .with_context(|| format!("invalid keypair JSON in {path}"))?;
    Keypair::try_from(secret_key.as_slice())
        .with_context(|| format!("invalid sender keypair bytes in {path}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn derives_default_sender_and_checks_optional_pubkey() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "sendtx-bench-sender-{}-{unique}",
            std::process::id()
        ));
        let wallets = root.join("wallets");
        fs::create_dir_all(&wallets).unwrap();
        let keypair = Keypair::new();
        let path = wallets.join("alpha.json");
        fs::write(
            &path,
            serde_json::to_vec(&keypair.to_bytes().to_vec()).unwrap(),
        )
        .unwrap();
        let config = root.join("config.toml");
        let config = config.to_str().unwrap();

        let (actual_path, sender) = load_provider_sender(config, "alpha", None, None).unwrap();
        assert_eq!(actual_path, path.to_str().unwrap());
        assert_eq!(sender.pubkey(), keypair.pubkey());
        let (_, overridden) = load_provider_sender(
            config,
            "beta",
            Some("wallets/alpha.json"),
            Some(&keypair.pubkey().to_string()),
        )
        .unwrap();
        assert_eq!(overridden.pubkey(), keypair.pubkey());
        assert!(
            load_provider_sender(
                config,
                "alpha",
                None,
                Some(&Pubkey::new_unique().to_string())
            )
            .is_err()
        );
        assert!(load_provider_sender(config, "missing", None, None).is_err());

        fs::remove_dir_all(root).unwrap();
    }
}
