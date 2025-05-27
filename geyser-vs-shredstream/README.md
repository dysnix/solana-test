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
ShredStream gRPC is faster in ~87% of cases, and it outperforms Yellowstone by ~50ms on average, with the maximum by ~2.3s.

```log
Results:
Total transactions compared: 4801635
deshred.txt earlier: 4202493 (87.5%)
yellowstone.txt earlier: 599008 (12.5%)
Same timestamp: 134 (0.0%)

When deshred.txt is earlier:
Average time earlier: 48.983ms
Maximum time earlier: 2304.942ms
Minimum time earlier: 0.001ms
Number of cases: 4202493

When yellowstone.txt is earlier:
Average time earlier: 52.126ms
Maximum time earlier: 2988.924ms
Minimum time earlier: 0.001ms
Number of cases: 599008
```