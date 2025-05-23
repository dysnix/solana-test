import json
import sys
import time
import numpy as np
import os
import re
from datetime import datetime

def parse_timestamp_to_ns(ts):
    try:
        # Parse RFC3339 timestamp with nanoseconds
        dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
        # Convert to nanoseconds since epoch
        return int(dt.timestamp() * 1_000_000_000)
    except Exception as e:
        print(f"Warning: Failed to parse timestamp {ts}: {e}")
        return None

def load_txns(path):
    data = {}
    with open(path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                timestamp, signature = line.split(' ', 1)
                data[signature] = timestamp
            except ValueError:
                print(f"Warning: Invalid line format:\n{line}")
                continue
    return data

def compare_txns(file1, file2):
    data1 = load_txns(file1)
    data2 = load_txns(file2)

    txns1 = set(data1.keys())
    txns2 = set(data2.keys())

    only_in_file1 = txns1 - txns2
    only_in_file2 = txns2 - txns1
    in_both = sorted(txns1 & txns2)

    diffs_ns = []
    
    # Debug: Print first few matching transactions
    print("\n[DEBUG] Sample timestamp comparisons:")
    sample_size = min(5, len(in_both))
    for txn in in_both[:sample_size]:
        ts1 = data1.get(txn)
        ts2 = data2.get(txn)
        t1_ns = parse_timestamp_to_ns(ts1)
        t2_ns = parse_timestamp_to_ns(ts2)
        if t1_ns is not None and t2_ns is not None:
            diff_ms = (t2_ns - t1_ns) / 1_000_000
            print(f"Txn: {txn}")
            print(f"  File1: {ts1} -> {t1_ns}")
            print(f"  File2: {ts2} -> {t2_ns}")
            print(f"  Diff: {diff_ms:.2f} ms")
            print()

    for txn in in_both:
        ts1 = data1.get(txn)
        ts2 = data2.get(txn)

        t1_ns = parse_timestamp_to_ns(ts1)
        t2_ns = parse_timestamp_to_ns(ts2)

        if t1_ns is None or t2_ns is None:
            continue

        diffs_ns.append(t2_ns - t1_ns)

    if not diffs_ns:
        print("No valid matching transactions found.")
        return

    diffs_ns = np.array(diffs_ns)
    avg_ns = np.mean(diffs_ns)
    p75_ns = np.percentile(diffs_ns, 75)
    p90_ns = np.percentile(diffs_ns, 90)
    p95_ns = np.percentile(diffs_ns, 95)
    p99_ns = np.percentile(diffs_ns, 99)

    earlier = np.sum(diffs_ns < 0)
    later = np.sum(diffs_ns > 0)

    total = len(diffs_ns)

    avg_ms = avg_ns / 1_000_000
    p75_ms = p75_ns / 1_000_000
    p90_ms = p90_ns / 1_000_000
    p95_ms = p95_ns / 1_000_000
    p99_ms = p99_ns / 1_000_000

    file1_name = os.path.basename(file1)
    file2_name = os.path.basename(file2)

    print("\n[SUMMARY]")
    print(f"  File 1: {file1_name}")
    print(f"    Unique txns: {len(txns1)}")
    print(f"  File 2: {file2_name}")
    print(f"    Unique txns: {len(txns2)}")
    print(f"  Matching txns: {total}")
    print(f"  Txns only in {file1_name}: {len(only_in_file1)}")
    print(f"  Txns only in {file2_name}: {len(only_in_file2)}")

    print(f"\n  Avg ΔcreatedAt: {avg_ms:.6f} ms")
    print(f"  75th percentile Δ: {p75_ms:.6f} ms")
    print(f"  90th percentile Δ: {p90_ms:.6f} ms")
    print(f"  95th percentile Δ: {p95_ms:.6f} ms")
    print(f"  99th percentile Δ: {p99_ms:.6f} ms")

    print(f"\n  {earlier / total * 100:.2f}% of txns: {file2_name} is earlier than {file1_name}")
    print(f"  {later / total * 100:.2f}% of txns: {file2_name} is later than {file1_name}")

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python tx_latency_compare.py file1.txt file2.txt")
        sys.exit(1)

    compare_txns(sys.argv[1], sys.argv[2])
