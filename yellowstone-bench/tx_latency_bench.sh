#!/usr/bin/env bash

########################################################
###### adjust these variables for your needs ###########
########################################################
BENCH_DURATION_SECONDS=300
YELLOWSTONE_GRPC_URL_0="solana-yellowstone-grpc.rpcfast.net:443"
YELLOWSTONE_GRPC_URL_1="solana-yellowstone-grpc.rpcfast.net:443"
YELLOWSTONE_GRPC_X_TOKEN_0="1234567890"
YELLOWSTONE_GRPC_X_TOKEN_1="1234567890"
FILENAME_0="txs_0.json"
FILENAME_1="txs_1.json"

########################################################
###### do not modify below here ########################
########################################################

SUBSCRIBE_REQUEST_JSON='{
    "slots": {},
    "accounts": {},
    "transactions": { "alltxs": { "vote": false, "failed": false } },
    "blocks": {},
    "blocks_meta": {},
    "accounts_data_slice": [],
    "commitment": 0
}'

subscribe_txs() {
    grpcurl \
        -max-time ${BENCH_DURATION_SECONDS} \
        -H 'X-Token: ${2}' \
        -proto geyser.proto \
        -d "${SUBSCRIBE_REQUEST_JSON}" \
        ${1} \
        geyser.Geyser/Subscribe
}

parse_json() {
    jq '{
            "txn": .transaction.transaction.signature,
            "createdAt": .createdAt
        }'
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
    subscribe_txs ${YELLOWSTONE_GRPC_URL_0} ${YELLOWSTONE_GRPC_X_TOKEN_0} | parse_json | tee -a "$FILENAME_0" &
    s0=$!

    subscribe_txs ${YELLOWSTONE_GRPC_URL_1} ${YELLOWSTONE_GRPC_X_TOKEN_1} | parse_json | tee -a "$FILENAME_1" &
    s1=$!

    trap "kill -9 $s1; kill -9 $s0" INT TERM EXIT

    sleep ${BENCH_DURATION_SECONDS}
    echo "Benchmark complete! Stored results in: ${FILENAME_0} and ${FILENAME_1}"
}

ensure_requirements
main
