# RPC latency benchmark

This benchmark will make 20 sequential requests to Solana RPCFast test endpoint and display the latency for every request.

## Requirements

Please make sure following tools are installed on your machine.

- `bash`
- `curl`
- `awk`

## Run benchmark

1. Obtain API key by registering at https://solana.rpcfast.com
2. Run benchmark using `API_KEY=<your_rpc_api_key> bash rpc_latency_bench.sh`.
