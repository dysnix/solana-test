# sendtx-bench-rs

Rust rewrite of the transfer benchmark from `sendtx-bench/transfer.py`, optimized to keep
`sendTransaction` HTTP connections persistent with a single reusable `reqwest` client.

## Behavior

- Uses `RPC_URL` for read RPCs (balance, blockhash, status).
- Uses `SEND_TX_RPC_URL` for `sendTransaction`.
- Sends USDT transfer (`amount=10_000`, `decimals=6`) with priority fee and optional tip.
- Checks sender USDT and SOL balances before send.
- Uses a simple fast confirmation loop (`confirmed` only, short fixed timeout/polling).
- Writes benchmark output to JSON with the same schema as Python.

## Environment

Copy values from `sendtx-bench/.env` or set manually:

- `API_KEY` (optional if full URLs already provided)
- `RPC_URL` (supports `${API_KEY}` placeholder)
- `SEND_TX_RPC_URL` (supports `${API_KEY}` placeholder)
- `RECEIVER_PUBLIC_KEY` (required)
- `TIP_ACCOUNT` (optional)
- `TIP_AMOUNT` (optional, lamports, default `1000000`)

`sender_pk.json` must exist in the current working directory.

## Run

```bash
cargo run --release -- --runs 5
```

Custom output file:

```bash
cargo run --release -- --runs 5 --output my_results.json
```
