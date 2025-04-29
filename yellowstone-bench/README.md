# Yellowstone gRPC benchmark

This benchmark will make request to 2 endpoints, subscribe to all txs stream and compare which of them is faster.

## Run benchmark

1. Please configure adjustable variables inside `tx_latency_bench.sh` file.
2. Run bash script to gather data for comparison. The data will be saved to 2 files.
```bash
bash tx_latency_bench.sh
```
3. Run python script to compare the data.
```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python tx_latency_bench.py <file_1> <file_2>
```
