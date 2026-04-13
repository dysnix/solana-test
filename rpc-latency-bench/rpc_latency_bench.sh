#!/usr/bin/env bash

########################################################
###### adjust these variables for your needs ###########
########################################################
API_KEY=${API_KEY:?"is missing"}
RPC="https://solana-rpc.rpcfast.com/?api_key=${API_KEY}"

########################################################
###### do not modify below here ########################
########################################################

temp=$(mktemp)
trap "rm -f $temp" INT TERM EXIT

RPCS=()
OPTS=()
for i in {1..20}; do RPCS+="$RPC "; OPTS+="-o /dev/null "; done

curl ${RPCS[@]} ${OPTS[@]} -s -w '%{time_total}\n' -d '
    {
        "jsonrpc":"2.0",
        "method":"getHealth",
        "id":1
    }' >> $temp

cat $temp | awk '{ printf "Request #" NR ": %.2f ms\n", $1 * 1000; sum += $1 } END { if (NR > 0) printf "=====================\nAverage: %.2f ms\n", (sum / NR) * 1000 }'
