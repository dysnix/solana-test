# Geyser vs Shredstream txs benchmark

This benchmark will subscribe to all txs via Solana Geyser (Yellowstone) and ShredStream, and then compare timestamps of matching transactions between both.

## Run benchmark

1. Set needed variables
```bash
export YELLOWSTONE_GRPC_X_TOKEN="your_token"
export SHREDSTREAM_AUTH_TOKEN="your_token"
export YELLOWSTONE_GRPC_URL="your_yellowstone_grpc_endpoint"
export SHREDSTREAM_GRPC_URL="your_shredstream_grpc_endpoint"
```
2. Run both commands at the same time: `bash geyser.sh` and `bash shredstream.sh`
3. Run `python compare.py results/txs_geyser.txt results/txs_shredstream.txt` to get the results.

## Results
On average, you receive transactions 2 minutes earlier via Shredstream gRPC compared to Yellowstone gRPC.

```
Comparison Results:
Total transactions compared: 9209
txs_geyser.txt earlier: 0
txs_shredstream.txt earlier: 9209
Same timestamp: 0

Time Difference Statistics:
Average difference: 2m2s227ns
Maximum difference: 4m6s130ns
Minimum difference: 770ns
```