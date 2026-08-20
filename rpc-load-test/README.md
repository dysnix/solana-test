# Solana RPC load test

Tool for benchmarking throughput, latency and load testing of Solana RPC endpoint.
Supports most popular RPC methods. Params can use mock data or real data if websocket endpoint is provided.
For the best results please specify target RPS as `your_plan_rps_limit * 0.95`.
In this case you should not expect any HTTP 429 errors.

`Worker count`:`RPS` ratio should be set to approximately `1:6` (i.e. 475 RPS, 80 workers) to achieve best results, but it also depends on your machine specs and RPC endpoint performance.

### Requirements
- Node 22+

## Building

```shell
npm ci
npm run build
```

## Help

```shell
npm run start -- --help
```

## Example

```shell
export MY_API_KEY="your-api-key"
npm run start -- \
--duration 120 \
--endpoint "https://solana-rpc.rpcfast.com/?api_key=${MY_API_KEY}" \
--websocket "wss://solana-rpc.rpcfast.com/?api_key=${MY_API_KEY}" \
--rps 475 \
--method-exclude getProgramAccounts \
--concurrent 80 \
--progress
```

Pressing `Ctrl+C` (or sending `SIGTERM`) stops scheduling requests, waits for in-flight workers, and prints the results captured before the interruption. Configured JSON or CSV exports are also written before the process exits. A second signal forces immediate shutdown.
