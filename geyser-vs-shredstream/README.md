# Geyser vs Shredstream txs benchmark

This benchmark will subscribe to all txs via Solana Geyser (Yellowstone) and ShredStream, and then compare timestamps of matching transactions between both.

## Run benchmark

```bash
bash bench.sh \
    --yellowstone-url <url> \
    --yellowstone-token <token> \
    --shredstream-url <url> \
    --shredstream-token <token> \
    [--duration <duration>]
```

## Results
ShredStream gRPC is faster in ~70% of cases, and it outperforms Yellowstone by 30-40ms on average, with the maximum by ~450ms.

```log
Results:
Total transactions compared: 1254320
deshred.txt earlier: 881425 (70.3%)
yellowstone.txt earlier: 372850 (29.7%)
Same timestamp: 45 (0.0%)

When deshred.txt is earlier:
Average time earlier: 34.885ms
Maximum time earlier: 434.856ms
Minimum time earlier: 0.001ms
Number of cases: 881425

When yellowstone.txt is earlier:
Average time earlier: 46.903ms
Maximum time earlier: 885.845ms
Minimum time earlier: 0.001ms
Number of cases: 372850
```