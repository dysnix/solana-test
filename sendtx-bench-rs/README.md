# sendtx-bench-rs

RPC sendTransaction benchmark with sequential provider testing and comparison reporting.

## Configuration

Uses TOML config (default: `config.toml`):

```toml
[[receiver]]
pubkey = "..."
private_key = "receiver_pk.json"

[[sender]]
pubkey = "..."
private_key = "sender_pk.json"

[[global]]
tip_amount = 1000000
priority_fee_lamports = 1000000
rpc_url = "https://..."

[[provider]]
name = "rpcfast-astralane"
# Optional per-provider overrides:
# rpc_url = "https://..."
# tip_amount = 1500000
# priority_fee_lamports = 1200000
send_tx_rpc_url = "https://..."
tip_accounts = ["...", "..."]
```

Notes:
- `global.priority_fee_lamports` is used as compute unit limit.
- `global.tip_amount` and `global.rpc_url` apply to all providers.
- Any provider can override those global values via optional `rpc_url`, `tip_amount`,
  and `priority_fee_lamports`.
- Compute unit price is fixed to `1` micro-lamport/CU.
- Tip account is randomly rotated per transaction from `tip_accounts`.
- No dotenv/env fallback is used.

## Run

Single provider (default first provider if `--providers` omitted):

```bash
cargo run --release -- --runs 5 --providers rpcfast-astralane
```

Subset of providers:

```bash
cargo run --release -- --runs 5 --providers rpcfast-astralane,rpcfast-nozomi
```

All providers:

```bash
cargo run --release -- --runs 5 --providers all
```

## Outputs

- Single provider run writes JSON output (default: `transfer_results_<timestamp>.json`).
- Multi-provider run (`all` or 2+ selected providers) writes:
  - markdown comparison table (default: `provider_comparison_<timestamp>.md`)
  - JSON comparison payload with all provider runs/metrics (default: same filename
    with `.json` extension, e.g. `provider_comparison_<timestamp>.json`)

Custom output paths:

```bash
# Single-provider JSON
cargo run --release -- --runs 5 --providers rpcfast-astralane --output result.json

# Multi-provider markdown
cargo run --release -- --runs 5 --providers all --markdown-output compare.md
```
