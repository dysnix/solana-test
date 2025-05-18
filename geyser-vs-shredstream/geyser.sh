#!/usr/bin/env bash

########################################################
###### adjust these variables for your needs ###########
########################################################
BENCH_DURATION_SECONDS=300
YELLOWSTONE_GRPC_URL=${YELLOWSTONE_GRPC_URL:-"solana-yellowstone-grpc.rpcfast.net:443"}
YELLOWSTONE_GRPC_X_TOKEN=${YELLOWSTONE_GRPC_X_TOKEN:-"1234567890"}
SCRIPT_DIR="$(dirname $(realpath $0))"
FILENAME="${SCRIPT_DIR}/results/txs_geyser.txt"

########################################################
###### do not modify below here ########################
########################################################

SUBSCRIBE_REQUEST_JSON='{
    "slots": {},
    "accounts": {},
    "transactions": {
        "alltxs": {}
    },
    "blocks": {},
    "blocks_meta": {},
    "accounts_data_slice": [],
    "commitment": 0
}'

subscribe_txs() {
    grpcurl \
        -max-time ${BENCH_DURATION_SECONDS} \
        -H "X-Token: ${2}" \
        -proto geyser.proto \
        -d "${SUBSCRIBE_REQUEST_JSON}" \
        ${1} \
        geyser.Geyser/Subscribe
}

parse_json() {
    jq -r .transaction.transaction.signature
}

ensure_requirements() {
    for i in jq grpcurl; do
        if ! command -v ${i} &> /dev/null; then
            echo "Required tool ${i} is not installed. Please install it and try again."
            exit 1
        fi
    done
}

main() {
    rm -f "${FILENAME}" || true

    cd "${SCRIPT_DIR}/../yellowstone-bench"

    while read -r line; do
        sig=$(echo "$line" | base64 -d | base58)
        echo "$(date -u '+%Y-%m-%dT%H:%M:%S.%N%:z') $sig" | tee -a "$FILENAME"
    done < <(subscribe_txs ${YELLOWSTONE_GRPC_URL} ${YELLOWSTONE_GRPC_X_TOKEN} | parse_json) &
    s=$!

    trap "kill -9 $s" INT TERM EXIT

    sleep ${BENCH_DURATION_SECONDS}

    echo "Benchmark compslete! Stored results in: ${FILENAME}"

    cd "${OLDPWD}"
}

ensure_requirements
main
