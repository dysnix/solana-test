#!/usr/bin/env bash

OS=$(echo $(uname -s) | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

while [[ "$1" =~ ^- && ! "$1" == "--" ]]; do
  case "$1" in
    --duration ) shift; export BENCH_DURATION=$1 ;;
    --yellowstone-url ) shift; export YELLOWSTONE_GRPC_URL=$1 ;;
    --yellowstone-token ) shift; export YELLOWSTONE_GRPC_X_TOKEN=$1 ;;
    --shredstream-url ) shift; export SHREDSTREAM_GRPC_URL=$1 ;;
    --shredstream-token ) shift; export SHREDSTREAM_AUTH_TOKEN=$1 ;;
    *) break ;;
  esac
  shift
done

if [ -z "${YELLOWSTONE_GRPC_URL}" ] || [ -z "${YELLOWSTONE_GRPC_X_TOKEN}" ] || [ -z "${SHREDSTREAM_GRPC_URL}" ] || [ -z "${SHREDSTREAM_AUTH_TOKEN}" ]; then
    echo "Usage: $0 --yellowstone-url <url> --yellowstone-token <token> --shredstream-url <url> --shredstream-token <token> [--duration <duration>]"
    exit 1
fi

BENCH_DURATION=${BENCH_DURATION:-600}

./bin/deshred >> results/deshred.txt &
deshred_pid=$!

./bin/yellowstone_${OS}_${ARCH} -url ${YELLOWSTONE_GRPC_URL} -token ${YELLOWSTONE_GRPC_X_TOKEN} -duration "${BENCH_DURATION}s" -save -file results/yellowstone.txt &
yellowstone_pid=$!

trap "kill -9 $deshred_pid $yellowstone_pid; rm results/deshred.txt results/yellowstone.txt" EXIT INT TERM

sleep ${BENCH_DURATION}

$(which python) compare.py results/deshred.txt results/yellowstone.txt
