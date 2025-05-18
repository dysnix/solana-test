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
    # Calculate difference in seconds with ns precision
    diff = abs((timestamp1 - timestamp2).total_seconds())

    # Convert to hours, minutes, seconds, and nanoseconds
    hours = int(diff // 3600)
    minutes = int((diff % 3600) // 60)
    seconds = int(diff % 60)
    nanoseconds = int((diff - int(diff)) * 1_000_000_000)

    # Format the string
    parts = []
    if hours > 0:
        parts.append(f"{hours}h")
    if minutes > 0 or hours > 0:
        parts.append(f"{minutes}m")
    if seconds > 0 or minutes > 0 or hours > 0:
        parts.append(f"{seconds}s")
    if nanoseconds > 0:
        # Format nanoseconds to 3 digits
        ns_str = f"{nanoseconds:03d}"[:3]  # Take first 3 digits
        parts.append(f"{ns_str}ns")

    return "".join(parts) if parts else "0s"

def get_time_diff_seconds(timestamp1, timestamp2):
    # Calculate difference in seconds with ms precision
    diff = abs((timestamp1 - timestamp2).total_seconds())
    return round(diff, 3)

def compare_timestamps(file1_path, file2_path):
    # Dictionary to store timestamps for each transaction hash
    tx_timestamps = defaultdict(dict)

    # Debug: Print first few lines from each file
    print("\nDebug: First few lines from each file:")
    print("\nFile 1:")
    with open(file1_path, 'r') as f1:
        for i, line in enumerate(f1):
            if i < 3:  # Print first 3 lines
                timestamp, tx_hash = parse_timestamp_line(line)
                if timestamp and tx_hash:
                    print(f"Original: {line.strip()}")
                    print(f"Parsed: {timestamp.isoformat()} {tx_hash}")
                    print()
            timestamp, tx_hash = parse_timestamp_line(line)
            if timestamp and tx_hash:
                tx_timestamps[tx_hash]['file1'] = timestamp

    print("\nFile 2:")
    with open(file2_path, 'r') as f2:
        for i, line in enumerate(f2):
            if i < 3:  # Print first 3 lines
                timestamp, tx_hash = parse_timestamp_line(line)
                if timestamp and tx_hash:
                    print(f"Original: {line.strip()}")
                    print(f"Parsed: {timestamp.isoformat()} {tx_hash}")
                    print()
            timestamp, tx_hash = parse_timestamp_line(line)
            if timestamp and tx_hash:
                tx_timestamps[tx_hash]['file2'] = timestamp

    # Compare timestamps
    file1_earlier = 0
    file2_earlier = 0
    same_time = 0
    total_compared = 0
    total_diff_seconds = 0
    max_diff_seconds = 0
    min_diff_seconds = float('inf')

    print("\nCompared Transactions:")
    print("=" * 100)
    print(f"{'Transaction Hash':<64} {'File 1 Timestamp':<30} {'File 2 Timestamp':<30} {'Diff':<15}")
    print("-" * 100)

    for tx_hash, timestamps in tx_timestamps.items():
        if 'file1' in timestamps and 'file2' in timestamps:
            total_compared += 1
            diff_seconds = get_time_diff_seconds(timestamps['file1'], timestamps['file2'])
            total_diff_seconds += diff_seconds
            max_diff_seconds = max(max_diff_seconds, diff_seconds)
            min_diff_seconds = min(min_diff_seconds, diff_seconds) if diff_seconds > 0 else min_diff_seconds

            # Print comparison details
            diff_str = format_time_diff(timestamps['file1'], timestamps['file2'])
            print(f"{tx_hash:<64} {timestamps['file1'].isoformat():<30} {timestamps['file2'].isoformat():<30} {diff_str:<15}")

            if timestamps['file1'] < timestamps['file2']:
                file1_earlier += 1
            elif timestamps['file1'] > timestamps['file2']:
                file2_earlier += 1
            else:
                same_time += 1

    print("=" * 100)

    # Print results
    print(f"\nComparison Results:")
    print(f"Total transactions compared: {total_compared}")
    print(f"{os.path.basename(file1_path)} earlier: {file1_earlier}")
    print(f"{os.path.basename(file2_path)} earlier: {file2_earlier}")
    print(f"Same timestamp: {same_time}")
    if total_compared > 0:
        avg_diff_seconds = total_diff_seconds / total_compared
        print(f"\nTime Difference Statistics:")
        print(f"Average difference: {format_time_diff(datetime.now(), datetime.now() + timedelta(seconds=avg_diff_seconds))}")
        print(f"Maximum difference: {format_time_diff(datetime.now(), datetime.now() + timedelta(seconds=max_diff_seconds))}")
        print(f"Minimum difference: {format_time_diff(datetime.now(), datetime.now() + timedelta(seconds=min_diff_seconds))}")

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
