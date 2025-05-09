# Solana RPC Benchmark Results

## Performance Metrics

| Configuration | Avg Slot Diff | Max Slot Diff | Min Slot Diff | Avg Time Diff (s) | Avg Priority Fee | Success Rate | Total Runs |
|---------------|---------------|---------------|---------------|-------------------|------------------|--------------|------------|
| rpcfast_balanced | 1.75 | 3 | 1 | 0.85 | 100,000 | 20/20 | 20 |
| rpcfast_staked | 3.3 | 7 | 1 | 1.4 | 100,000 | 20/20 | 20 |
| helius_staked | 5.95 | 13 | 3 | 2.35 | 100,000 | 20/20 | 20 |
| rpcfast_default | 5.85 | 15 | 3 | 2.55 | 100,000 | 20/20 | 20 |
| helius_default | 5.85 | 15 | 3 | 2.25 | 100,000 | 20/20 | 20 |

## Endpoints

| Configuration | Endpoint |
|---------------|----------|
| rpcfast_balanced | `https://solana-rpc.rpcfast.net/trader/?tx_submit_mode=balanced&tip_amount=1000000` |
| rpcfast_staked | `https://solana-rpc.rpcfast.net/trader/?tx_submit_mode=fastest&tip_amount=1000000` |
| helius_staked | `https://staked.helius-rpc.com/` |
| rpcfast_default | `https://solana-rpc.rpcfast.net` |
| helius_default | `https://mainnet.helius-rpc.com/` |

## Key Findings

1. **Performance Ranking**:
   - rpcfast_balanced shows the best performance with:
     - Lowest average slot difference (1.75)
     - Lowest average time difference (0.85s)
     - Smallest max slot difference (3)
     - Smallest min slot difference (1)
   - rpcfast_staked comes in second with:
     - Average slot difference of 3.3
     - Average time difference of 1.4s
   - helius_default and rpcfast_default show identical slot differences but different time differences
   - helius_staked shows slightly better performance than the default configurations

2. **Success Rate**:
   - All configurations achieved 100% success rate (20/20 successful runs)

3. **Priority Fees**:
   - All configurations used a consistent priority fee of 100,000 lamports
   - rpcfast_staked and rpcfast_balanced configurations use a tip amount of 1,000,000 lamports

4. **Time Performance**:
   - rpcfast_balanced has the fastest average confirmation time (0.85s)
   - rpcfast_staked is second fastest (1.4s)
   - helius_default performs better than rpcfast_default in terms of time (2.25s vs 2.55s) 