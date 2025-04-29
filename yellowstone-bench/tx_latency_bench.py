import json
import sys
from dateutil import parser
from datetime import timezone
import numpy as np
import os

def load_multiline_json_objects(path):
    data = {}
    buf = []

    with open(path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            buf.append(line)
            if line == "}":
                try:
                    obj = json.loads("\n".join(buf))
                    txn = obj.get("txn")
                    created_at = obj.get("createdAt")
                    if txn and created_at:
                        data[txn] = created_at
                except json.JSONDecodeError:
                    print(f"Warning: Invalid JSON object:\n{''.join(buf)}")
                buf = []

    return data

def parse_timestamp_to_ns(ts):
    try:
        dt = parser.isoparse(ts).astimezone(timezone.utc)
        return int(dt.timestamp() * 1_000_000_000)
    except Exception:
        return None

def compare_txns(file1, file2):
    data1 = load_multiline_json_objects(file1)
    data2 = load_multiline_json_objects(file2)

    txns1 = set(data1.keys())
    txns2 = set(data2.keys())

    only_in_file1 = txns1 - txns2
    only_in_file2 = txns2 - txns1
    in_both = sorted(txns1 & txns2)

    diffs_ns = []

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
        print("Usage: python compare_txns_ns.py file1.json file2.json")
        sys.exit(1)

    compare_txns(sys.argv[1], sys.argv[2])
