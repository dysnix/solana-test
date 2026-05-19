# sendtx-bench-rs

A Solana `sendTransaction` benchmark that measures end-to-end landing latency
across one or more RPC providers. Designed for evaluating relay-style senders
(rpcfast Aperture, Astralane, BloXroute, Nozomi, vanilla RPC, …) under directly
comparable conditions.

The benchmark tracks transaction landing via Yellowstone-style gRPC
subscriptions instead of RPC polling, so latency numbers are measured with
slot-level fidelity rather than RPC poll-interval granularity.

## What it does

For each provider you configure, the benchmark:

1. Connects to a gRPC endpoint and waits for the slot stream to come online.
2. Verifies sender SOL balance up-front (fail-fast across all selected providers).
3. Dispatches one signed transaction **per gRPC slot tick** to a provider's
   `sendTransaction` URL — any Yellowstone-compatible gRPC endpoint works as
   the slot source. Aligning every send with a fresh slot edge gives us the
   best-case landing position to measure.
4. Waits for the gRPC Transaction event for that signature, plus the Block
   event from the blocks subscription which records the tx's index in the
   block.
5. Records per-run metrics and writes a JSON or Markdown comparison report.

A single transaction contains:

- `ComputeBudgetInstruction::set_compute_unit_limit(<configured>)`
- `ComputeBudgetInstruction::set_compute_unit_price(<configured> µlamports/CU)`
- `system_program::transfer(sender → random_tip_account, tip_amount + jitter)`

Tip jitter (0–1023 lamports) is added per run so simultaneous sends across
providers cannot collide on the same signature when the cached blockhash
overlaps.

## Architecture

```
   ┌─────────────────────────┐         ┌─────────────────────────┐
   │  gRPC sub: slots + txs  │         │   gRPC sub: blocks      │
   │  (primary, or optional  │         │   (records tx index in  │
   │   tracking endpoint)    │         │    block)               │
   └────────────┬────────────┘         └────────────┬────────────┘
                │ stream                             │ stream
                └────────────────┬───────────────────┘
                                 ▼
                  ┌────────────────────────────┐
                  │        GrpcTracker         │
                  │  - slot_state Condvar      │
                  │  - pending HashMap         │
                  └─┬────────┬─────────────────┘
                    │        │ LandingEvent
   wait_for_next_   │        │ (Transaction / Block)
   slot(N)          ▼        ▼
        ┌─────────────────────────┐  ┌───────────────────────┐
        │  Provider thread A      │  │  Provider thread B    │
        │  ─ build & sign tx      │  │  ─ build & sign tx    │
        │  ─ register pending     │  │  ─ register pending   │
        │  ─ POST sendTransaction │  │  ─ POST sendTx        │
        │  ─ wait for landing     │  │  ─ wait for landing   │
        └─────────────────────────┘  └───────────────────────┘
                  │                              │
                  └──────────► HTTP/2 ◄──────────┘
                          (kept-alive, multiplexed)
```

- One `GrpcTracker` is shared across all providers. It opens up to two
  Yellowstone-compatible subscriptions: one carrying slot ticks and
  transaction landings (the latency-critical streams), and one carrying
  blocks (used to recover each tx's index inside its block).
- The slots subscriber notifies a `Condvar`; every provider thread wakes on
  each slot tick and dispatches concurrently.
- Optionally, the slots+transactions stream can be offloaded to a faster
  endpoint (e.g. rpcfast Aperture, ~30–40 ms ahead of vanilla Yellowstone
  since it decodes from shreds), with the primary endpoint serving only
  blocks for index-in-block resolution. Without that override, a single
  Yellowstone endpoint carries all three filters.
- Which slot status wakes the dispatch loop depends on the role:
  - **Single-endpoint mode** (no `grpc_tracking_url`): the unified subscriber
    triggers on `SlotProcessed`.
  - **Split-endpoint mode**: the tracking subscriber triggers on
    `SlotFirstShredReceived` — the earliest signal that the next leader has
    started producing the upcoming block. This matches Aperture's behavior
    (it only emits `SlotFirstShredReceived` + `SlotCompleted` and ignores
    both `filter_by_commitment` and `interslot_updates`), and gives the
    dispatch loop the earliest possible slot edge to fire on. The primary
    (blocks-only) subscriber still uses `SlotProcessed`.
- `sendTransaction` POSTs reuse a single HTTP/2 connection per provider
  (negotiated via ALPN with rustls). The blockhash is refreshed in a
  background thread every 400 ms so signing never blocks on RPC.

## Prerequisites

- Rust toolchain (edition 2024 — `rustc` ≥ 1.85).
- One funded sender keypair per provider you want to benchmark in parallel
  (recommended — see "Sender isolation").
- A Yellowstone-compatible gRPC endpoint (mainnet) + optional Aperture
  endpoint for tracking.
- HTTP `sendTransaction` URL for each provider you want to compare.

Sufficient SOL for `runs × (tip_amount + 50_000 lamports buffer)` per
provider's sender; the preflight check will tell you exactly how much.

## Configuration

The benchmark reads a TOML file (default `config.toml`). Start by copying
`config.example.toml`. Schema:

```toml
[[receiver]]
pubkey = "<receiver pubkey>"
private_key = "receiver_pk.json"   # only the pubkey is actually used

[[sender]]
pubkey = "<default sender pubkey>"
private_key = "sender_pk.json"     # JSON-array keypair file (Solana CLI format)

[[global]]
# Default tip in lamports (relay providers). For pure RPC paths, can be 0
# but you still need the tip_accounts entry empty.
tip_amount = 1_000_000

# Compute budget for the dispatched tx. 100k leaves comfortable headroom
# even though the current tx only needs the system_program transfer.
compute_unit_limit = 100_000
compute_unit_price_micro_lamports = 100_000

# Default RPC URL for blockhash refresh + balance checks.
rpc_url = "https://solana-rpc.example.com/?api_key=..."

# Default sendTransaction URL (used by providers that don't override).
send_tx_rpc_url = "https://beam.rpcfast.com/?api_key=..."

# Primary gRPC endpoint. With grpc_tracking_url unset it carries
# slots + transactions + blocks. With it set, this endpoint serves
# blocks only.
grpc_url = "https://yellowstone-grpc.example.com"
# grpc_x_token = "<optional auth token>"

# Optional faster endpoint for slots + transactions
# (e.g. rpcfast Aperture). When set, slot tracking and tx-landing
# detection both use this endpoint; the primary endpoint is used only
# for blocks (so you still get index-in-block).
# grpc_tracking_url = "https://aperture-grpc.rpcfast.com"
# grpc_tracking_x_token = ""

[[provider]]
name = "rpcfast-astralane"
# Per-provider override for the sendTransaction URL.
send_tx_rpc_url = "https://beam.rpcfast.com/?provider=astralane&mode=fastest&api_key=..."
tip_accounts = [
  "BBtip8kpHzYPD2hhrcwV6P2stL7GRqxpiVkHBomSMrVB",
  "BBtiphcAHYAYUrurxjtJQaiswFnvrWZU3sRu7X3NGzfU",
]
# Recommended: dedicated sender per provider for safe parallel benchmarking.
# Both fields must be set together.
sender_pubkey = "<provider-A sender pubkey>"
sender_private_key = "providerA_sender_pk.json"

# Optional per-provider overrides for global defaults:
# rpc_url = "..."
# tip_amount = 1_500_000
# compute_unit_limit = 100_000
# compute_unit_price_micro_lamports = 200_000
```

### Sender isolation

When benchmarking multiple providers in parallel they all submit transactions
on the same chain; if they share a fee-payer the parallel submissions will
contend on the same nonce/account state and serialize behind each other. The
recommended pattern is **one sender keypair per provider**, set explicitly:

```toml
[[provider]]
name = "rpcfast-astralane"
sender_pubkey = "<sender A pubkey>"
sender_private_key = "senderA_pk.json"
…

[[provider]]
name = "rpcfast-bloxroute"
sender_pubkey = "<sender B pubkey>"
sender_private_key = "senderB_pk.json"
…
```

Each per-provider sender needs `runs × (tip_amount + 50_000)` lamports.

## Running

Build:

```bash
cargo build --release
```

Single provider (the first one in the config if `--providers` is omitted):

```bash
cargo run --release -- --runs 20 --providers rpcfast-astralane
```

A subset:

```bash
cargo run --release -- --runs 20 --providers rpcfast-astralane,rpcfast-nozomi
```

All providers (parallel):

```bash
cargo run --release -- --runs 20 --providers all
```

Custom config file:

```bash
cargo run --release -- --runs 20 --providers all --config my-config.toml
```

### CLI flags

| Flag | Description |
| --- | --- |
| `--runs N` | Number of transactions per provider. Default `1`. |
| `--providers <list>` | Provider name(s), comma-separated, or `all`. |
| `--config <path>` | TOML config path. Default `config.toml`. |
| `--output <path>` | Single-provider JSON output path. |
| `--markdown-output <path>` | Multi-provider Markdown report path. |

### Regenerating a report from a saved JSON

The `report` subcommand re-renders the Markdown comparison from a previously
saved comparison JSON without re-running the benchmark. The
`performance_rate_pct` is recomputed from the raw results, so this is also
the way to apply a newer scoring formula to historical data.

```bash
# Output defaults to <input>.md alongside the JSON.
cargo run --release -- report provider_comparison_20260420_121307.json

# Or specify an explicit output path.
cargo run --release -- report \
  provider_comparison_20260420_121307.json \
  --output report.md
```

### What you'll see at startup

```
Selected providers: rpcfast-astralane, rpcfast-nozomi
Default sender: <pubkey>
Selected receiver: <pubkey>
Preflight: sender <A> balance 50000000 lamports (need >= 21000000 for 20 runs × providers [rpcfast-astralane])
Preflight: sender <B> balance 50000000 lamports (need >= 21000000 for 20 runs × providers [rpcfast-nozomi])
Connecting to gRPC: primary (blocks) https://… | tracking (slots+transactions) https://… | filtering on 2 sender pubkey(s)…
gRPC subscriber ready (current slot 417… ). Warming up for 5s…
Warmup complete (current slot 417… ).

=== Provider: rpcfast-astralane ===
[rpcfast-astralane] run 1/20 triggered by slot 417…
[rpcfast-astralane] run 1 | tip account: BBtip… | tip: 1000234
…
```

If any sender is short of funds, the preflight aborts the run before any
gRPC connection or transaction is sent.

## Output

### Single-provider mode

Writes one JSON file (default `transfer_results_<timestamp>.json`):

```json
{
  "provider_name": "rpcfast-astralane",
  "sender_pubkey": "…",
  "receiver_pubkey": "…",
  "results": [ { …per-run record… }, … ],
  "averages": { … }
}
```

### Multi-provider mode

Writes both:

- `provider_comparison_<timestamp>.md` — a Markdown table comparing all
  providers across averages, P90s, success ratio, and a normalized
  performance score.
- `provider_comparison_<timestamp>.json` — full per-run data plus the
  comparison summary.

### Per-run fields

| Field | Meaning |
| --- | --- |
| `signature` | Solana tx signature (verifiable on Explorer/Solscan). |
| `triggered_slot` | The gRPC slot tick that triggered this dispatch. |
| `submit_slot` | The latest gRPC-observed slot at the moment we POSTed (≥ `triggered_slot`). |
| `landed_slot` | The slot the leader actually included this tx in. |
| `landed_index_in_block` | Position in the block (lower is closer to the front). |
| `submit_to_landed_slots` | `landed_slot - submit_slot`. `0` ≈ same-slot landing. |
| `same_slot_landed` | Bool shortcut for `submit_to_landed_slots == 0`. |
| `send_ack_ms` | HTTP RTT for the `sendTransaction` POST (ms). |
| `submit_to_landed_ms` | Local clock from POST start to gRPC tx event arrival. |
| `submit_to_landed_grpc_ms` | gRPC `created_at` minus our wall-clock POST time. Should agree with `submit_to_landed_ms` ± a few ms. |
| `submit_to_block_received_ms` | Time until the block containing this tx was streamed (from primary gRPC). |
| `priority_fee` | `cu_price * cu_limit / 1_000_000` lamports (informational). |
| `timed_out` | True if no landing event arrived within the confirm timeout (2 s). |
| `error` | Tx error from the gRPC stream, e.g. `InstructionError(...)`, or a timeout message. |

### How to interpret the numbers

- **`submit_to_landed_slots = 0`** means the tx landed in the same slot the
  gRPC stream had announced as "current" at the moment of POST. This is the
  best-case outcome; using a shred-decoded tracking endpoint (e.g. rpcfast
  Aperture) makes 0-slot landings more frequently observable since you see
  the slot edge sooner.
- **`landed_index_in_block`** measures the leader's ordering. Lower is
  better; if you see a provider consistently in the first ~50 entries the
  relay is actively prioritizing your tx.
- **`send_ack_ms`** is purely the HTTP RTT — it is **not** included in
  `submit_to_landed_ms` correctness, but a high `send_ack_ms` (>50ms) hints
  at network distance to the relay.
- **`submit_to_landed_ms` < 30 ms is suspicious** — network RTT alone is
  usually >30 ms. If you see this consistently, raise an issue.

### Cross-provider performance score

In multi-provider runs the report includes a `performance_rate_pct` per
provider: a 0–100 normalized score averaged across five buckets. For each
bucket, the best provider scores 100 and others scale relative to that
best.

| Bucket | Inputs (lower is better unless noted) | Weighting within bucket |
| --- | --- | --- |
| `landed_ms` | `avg_submit_to_landed_grpc_ms`, `p90_submit_to_landed_grpc_ms` | 0.2 × avg + 0.8 × p90 |
| `landed_slots` | `avg_submit_to_landed_slots`, `p90_submit_to_landed_slots` | 0.2 × avg + 0.8 × p90 |
| `landed_idx` | `avg_landed_index_in_block`, `p90_landed_index_in_block` | 0.5 × avg + 0.5 × p90 |
| `same_slot` | same-slot landing count *(higher is better)* | n/a |
| `success_ratio` | landed runs / total runs *(higher is better)* | n/a |

`performance_rate_pct = mean(landed_ms, landed_slots, landed_idx, same_slot, success_ratio)`.

P90 is weighted heavier than avg for latency and slot-delta because tail
behavior is what kills a relay's usefulness in practice — a provider with a
good average but bad worst-case shouldn't outscore a steadier one.
Index-in-block uses an even 50/50 split: tail position in a block matters
less than tail latency, so p90 shouldn't dominate that bucket.

This score is intended for *relative* comparison within a single run, not
as an absolute quality measure. To re-score historical data with the
current formula, use the `report` subcommand on the saved comparison JSON.

## Tips for fair benchmarks

- Run ≥20 runs per provider to get meaningful percentiles.
- Run from a host geographically close to your senders' relays — Aperture
  is fast but can't fix transcontinental latency on the POST itself.
- Use a dedicated sender per provider so concurrent runs don't serialize
  through the same fee-payer.
- For relay providers, `tip_amount` matters far more than
  `compute_unit_price_micro_lamports`. For pure RPC paths the opposite is
  true.
- Don't compare runs taken at different times of day or across cluster
  congestion epochs — re-run all providers in the same session.

## Verifying a result

To independently verify a same-slot landing claim:

1. Take a `signature` and its `landed_slot` from the JSON output.
2. Look up the signature on Solana Explorer
   (`https://explorer.solana.com/tx/<signature>`).
3. The "Block" field there should match `landed_slot`.

## Troubleshooting

- **`timed out waiting for primary grpc subscriber to start`** — gRPC URL
  unreachable, wrong x_token, or TLS handshake failure. Verify the
  endpoint with `grpcurl` or a Yellowstone client.
- **`timed out waiting for next slot tick from gRPC (5s)`** — slot stream
  stalled. Network issue or endpoint-side problem; restart and check
  endpoint health.
- **All txs error with `[8, 0, 0, 0, 3, 40, 0, 0, 0]`** — historical CU
  exhaustion (variant 40 = ProgramFailedToComplete). The current tx has
  no memo so this shouldn't happen with the default 100k CU limit, but if
  you re-add CU-heavy instructions, raise `compute_unit_limit`.
- **`insufficient SOL balance` preflight error** — fund the sender or
  reduce `--runs` / `tip_amount`.
