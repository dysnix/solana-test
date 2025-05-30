# Geyser vs Shredstream txs benchmark

This benchmark will subscribe to all txs via Solana Geyser (Yellowstone) and ShredStream, and then compare timestamps of matching transactions between both.

## Run benchmark

```bash
bash bench.sh \
    --yellowstone-url <url> \
    --yellowstone-token <token> \
    --shredstream-url <url> \
    --shredstream-token <token> \
    [--duration <duration_in_seconds>]
```

## Results
ShredStream gRPC is faster than Yellowstone gRPC in ~65% of cases by ~32ms on average, with the maximum speed gain by ~1.3s.

```log
Total transactions compared: 2078707
deshred.txt earlier: 1341106 (64.5%)
yellowstone.txt earlier: 737561 (35.5%)
Same timestamp: 40 (0.0%)

When deshred.txt is earlier:
Average time earlier: 32.819ms
Maximum time earlier: 1323.036ms
Minimum time earlier: 0.001ms
Number of cases: 1341106

When yellowstone.txt is earlier:
Average time earlier: 44.706ms
Maximum time earlier: 359.574ms
Minimum time earlier: 0.001ms
Number of cases: 737561
```