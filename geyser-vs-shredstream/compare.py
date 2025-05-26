#!/usr/bin/env python3

import sys
import os
from datetime import datetime, timedelta
from collections import defaultdict

def parse_timestamp_line(line):
    try:
        timestamp_str, tx_hash = line.strip().split(' ', 1)
        timestamp = datetime.fromisoformat(timestamp_str)
        return timestamp, tx_hash
    except (ValueError, AttributeError) as e:
        print(f"Error parsing line: {line.strip()}")
        print(f"Error details: {str(e)}")
        return None, None

def format_time_diff(timestamp1, timestamp2):
    # Calculate difference in milliseconds
    diff = abs((timestamp1 - timestamp2).total_seconds() * 1000)
    return f"{diff:.3f}ms"

def get_time_diff_seconds(timestamp1, timestamp2):
    # Calculate difference in seconds with ms precision
    diff = abs((timestamp1 - timestamp2).total_seconds())
    return round(diff, 3)

def compare_timestamps(file1_path, file2_path):
    # Dictionary to store timestamps for each transaction hash
    tx_timestamps = defaultdict(dict)

    with open(file1_path, 'r') as f1:
        for i, line in enumerate(f1):
            timestamp, tx_hash = parse_timestamp_line(line)
            if timestamp and tx_hash:
                tx_timestamps[tx_hash]['file1'] = timestamp

    with open(file2_path, 'r') as f2:
        for i, line in enumerate(f2):
            timestamp, tx_hash = parse_timestamp_line(line)
            if timestamp and tx_hash:
                tx_timestamps[tx_hash]['file2'] = timestamp

    # Compare timestamps
    file1_earlier = 0
    file2_earlier = 0
    same_time = 0
    total_compared = 0
    
    # Track differences when each file is earlier
    file1_earlier_diffs = []  # How much earlier file1 is
    file2_earlier_diffs = []  # How much earlier file2 is

    for tx_hash, timestamps in tx_timestamps.items():
        if 'file1' in timestamps and 'file2' in timestamps:
            total_compared += 1

            if timestamps['file1'] < timestamps['file2']:
                file1_earlier += 1
                # How much earlier file1 is
                diff_seconds = (timestamps['file2'] - timestamps['file1']).total_seconds()
                file1_earlier_diffs.append(diff_seconds)
            elif timestamps['file1'] > timestamps['file2']:
                file2_earlier += 1
                # How much earlier file2 is
                diff_seconds = (timestamps['file1'] - timestamps['file2']).total_seconds()
                file2_earlier_diffs.append(diff_seconds)
            else:
                same_time += 1

    # Print results
    print(f"Results:")
    print(f"Total transactions compared: {total_compared}")
    
    # Calculate percentages
    file1_earlier_pct = (file1_earlier / total_compared * 100) if total_compared > 0 else 0
    file2_earlier_pct = (file2_earlier / total_compared * 100) if total_compared > 0 else 0
    same_time_pct = (same_time / total_compared * 100) if total_compared > 0 else 0
    
    print(f"{os.path.basename(file1_path)} earlier: {file1_earlier} ({file1_earlier_pct:.1f}%)")
    print(f"{os.path.basename(file2_path)} earlier: {file2_earlier} ({file2_earlier_pct:.1f}%)")
    print(f"Same timestamp: {same_time} ({same_time_pct:.1f}%)")
    
    if total_compared > 0:
        # Calculate and print average differences when each file is earlier
        if file1_earlier > 0:
            avg_file1_earlier = sum(file1_earlier_diffs) / file1_earlier
            max_file1_earlier = max(file1_earlier_diffs)
            min_file1_earlier = min(file1_earlier_diffs)
            print(f"\nWhen {os.path.basename(file1_path)} is earlier:")
            print(f"Average time earlier: {format_time_diff(datetime.now(), datetime.now() + timedelta(seconds=avg_file1_earlier))}")
            print(f"Maximum time earlier: {format_time_diff(datetime.now(), datetime.now() + timedelta(seconds=max_file1_earlier))}")
            print(f"Minimum time earlier: {format_time_diff(datetime.now(), datetime.now() + timedelta(seconds=min_file1_earlier))}")
            print(f"Number of cases: {file1_earlier}")
        
        if file2_earlier > 0:
            avg_file2_earlier = sum(file2_earlier_diffs) / file2_earlier
            max_file2_earlier = max(file2_earlier_diffs)
            min_file2_earlier = min(file2_earlier_diffs)
            print(f"\nWhen {os.path.basename(file2_path)} is earlier:")
            print(f"Average time earlier: {format_time_diff(datetime.now(), datetime.now() + timedelta(seconds=avg_file2_earlier))}")
            print(f"Maximum time earlier: {format_time_diff(datetime.now(), datetime.now() + timedelta(seconds=max_file2_earlier))}")
            print(f"Minimum time earlier: {format_time_diff(datetime.now(), datetime.now() + timedelta(seconds=min_file2_earlier))}")
            print(f"Number of cases: {file2_earlier}")

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python compare_timestamps.py <file1> <file2>")
        sys.exit(1)

    file1_path = sys.argv[1]
    file2_path = sys.argv[2]

    try:
        compare_timestamps(file1_path, file2_path)
    except FileNotFoundError as e:
        print(f"Error: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"An error occurred: {e}")
        sys.exit(1)
