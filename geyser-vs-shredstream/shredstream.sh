#!/usr/bin/env bash

########################################################
###### adjust these variables for your needs ###########
########################################################
BENCH_DURATION_SECONDS=300
SHREDSTREAM_GRPC_URL=${SHREDSTREAM_GRPC_URL:-"sol-shredstream-grpc.rpcfast.net:443"}
SHREDSTREAM_AUTH_TOKEN=${SHREDSTREAM_AUTH_TOKEN:-"1234567890"}
SCRIPT_DIR="$(dirname $(realpath $0))"
FILENAME="${SCRIPT_DIR}/results/txs_shredstream.txt"

########################################################
###### do not modify below here ########################
########################################################

rm -f "${FILENAME}" || true

./bin/deshred | tee -a "${FILENAME}" &
s=$!

trap "kill -9 $s" INT TERM EXIT

sleep ${BENCH_DURATION_SECONDS}

echo "Benchmark complete! Stored results in: ${FILENAME}"
