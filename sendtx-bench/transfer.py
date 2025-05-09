from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solana.rpc.api import Client
from solana.rpc.commitment import Confirmed
from spl.token.client import Token, TxOpts
from spl.token.constants import TOKEN_PROGRAM_ID
from spl.token.instructions import (
    get_associated_token_address,
    transfer_checked,
    TransferCheckedParams,
)
from solders.transaction import Transaction
from solders import compute_budget
from solders.message import Message
import time
import os
import json
import dotenv
import websockets
import asyncio
import argparse
import sys


dotenv.load_dotenv()

API_KEY = os.getenv("API_KEY")
HELIUS_API_KEY = os.getenv("HELIUS_API_KEY")
USDT_MINT = Pubkey.from_string("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB")
RPC_URL = f"https://solana-rpc.rpcfast.net/trader/?api_key={API_KEY}&tx_submit_mode=balanced&tip_amount=1000000"
# RPC_URL = f"https://staked.helius-rpc.com/?api-key=${HELIUS_API_KEY}"
# RPC_URL = f"https://solana-rpc.rpcfast.net/?api_key={API_KEY}"
WS_URL = f"wss://solana-rpc.rpcfast.net/ws/trader?api_key={API_KEY}"


async def get_priority_fee():
    async with websockets.connect(WS_URL) as websocket:
        # Subscribe to priority fee stream
        subscribe_msg = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "subscribe",
            "params": [
                "GetPriorityFeeStream",
                {
                    "project": "P_JUPITER",
                    "percentile": 90,
                },
            ],
        }
        await websocket.send(json.dumps(subscribe_msg))

        # Wait for the first valid response
        while True:
            msg = await websocket.recv()
            msg = json.loads(msg)
            if "params" in msg and "result" in msg["params"]:
                return int(
                    msg["params"]["result"].get("feeAtPercentile", 100000)
                )  # Default to 100000 if not found


def parse_args():
    parser = argparse.ArgumentParser(description="Run Solana token transfer benchmark")
    parser.add_argument(
        "--runs", type=int, default=1, help="Number of transfer runs to perform"
    )
    return parser.parse_args()


def run_transfer(priority_fee):
    # Setup
    client = Client(RPC_URL, commitment=Confirmed)
    send_tx_client = Client(RPC_URL, commitment=Confirmed)

    # Load keypair and define addresses
    with open("sender_pk.json", "rb") as f:
        secret_key = json.load(f)
    sender = Keypair.from_bytes(secret_key)
    receiver_pubkey = os.getenv("RECEIVER_PUBLIC_KEY")

    token = Token(client, USDT_MINT, TOKEN_PROGRAM_ID, sender)
    sender_acc = get_associated_token_address(sender.pubkey(), USDT_MINT)
    receiver_acc = get_associated_token_address(
        Pubkey.from_string(receiver_pubkey), USDT_MINT
    )

    # Define amount
    amount = 10_000  # 0.01 USDT

    # Check if receiver's token account exists
    print("\nChecking receiver's Associated Token Account...")
    try:
        receiver_acc_info = client.get_account_info(receiver_acc)
        if receiver_acc_info.value is None:
            print("Receiver's account doesn't exist. Creating it...")
            # Create receiver's token account
            create_acc_tx = token.create_associated_token_account(
                Pubkey.from_string(receiver_pubkey)
            )
            print(f"Create account transaction: {str(create_acc_tx)}")
            # Wait for token account creation to confirm
            time.sleep(2)  # Give some time for the account to be created
        else:
            print("Receiver's token account exists")
    except Exception as e:
        print(f"Error checking receiver's account: {e}")
        sys.exit(1)

    # Check sender's token balance
    print("\nChecking sender's token balance...")
    try:
        sender_balance = token.get_balance(sender_acc)
        print(f"Sender's balance: {sender_balance.value.amount}")
        if int(sender_balance.value.amount) < amount:
            print(
                f"Error: Insufficient balance. Have: {sender_balance.value.amount}, Need: {amount}"
            )
            sys.exit(1)
    except Exception as e:
        print(f"Error checking sender's balance: {e}")
        sys.exit(1)

    # Get recent blockhash
    print("Getting recent blockhash...")
    pre_block = client.get_latest_blockhash(commitment=Confirmed).value
    recent_blockhash = pre_block.blockhash
    print(f"Recent blockhash: {recent_blockhash}")

    # Create and send transaction
    print("\nCreating transfer transaction...")
    print(f"From: {sender_acc}")
    print(f"To: {receiver_acc}")
    print(f"Amount: {amount}")
    print(f"Priority fee: {priority_fee}")

    # Create compute budget instruction for priority fee
    priority_fee_ix = compute_budget.set_compute_unit_price(priority_fee)

    # Create transfer instruction
    transfer_ix = transfer_checked(
        TransferCheckedParams(
            program_id=TOKEN_PROGRAM_ID,
            source=sender_acc,
            mint=USDT_MINT,
            dest=receiver_acc,
            owner=sender.pubkey(),
            amount=amount,
            decimals=6,
            signers=[],
        )
    )

    # Fetch recent block info (before send)
    pre_slot = client.get_slot(commitment=Confirmed).value
    pre_slot_time = client.get_block_time(pre_slot).value
    print(f"Current slot: {pre_slot}")

    # Create transaction with both instructions
    message = Message.new_with_blockhash(
        [priority_fee_ix, transfer_ix], sender.pubkey(), recent_blockhash
    )
    tx = Transaction.new_unsigned(message)
    tx.sign([sender], recent_blockhash=recent_blockhash)

    print("\nSending transaction...")
    sent = send_tx_client.send_transaction(
        tx,
        opts=TxOpts(preflight_commitment=Confirmed, max_retries=2, skip_preflight=True),
    )
    signature = sent.value
    print("Transaction Signature:", signature)

    # Wait for confirmation
    print("Waiting for confirmation...")
    try:
        confirm_status = client.confirm_transaction(signature, commitment=Confirmed)
        if len(confirm_status.value) > 0:
            print(f"Transaction confirmed! {str(confirm_status.value[0])}")
        elif confirm_status.value[0].err is not None:
            print(f"Transaction failed: {confirm_status.value[0].err}")
            return None
        else:
            print("Failed to wait for confirmation")
            return None
    except Exception as e:
        print(f"Error confirming transaction: {e}")
        return None

    # Get post-confirmation block info
    confirmed_slot = confirm_status.value[0].slot
    confirmed_time = client.get_block_time(confirmed_slot).value

    # Calculate differences
    slot_diff = confirmed_slot - pre_slot
    time_diff = confirmed_time - pre_slot_time

    return {
        "pre_slot": pre_slot,
        "confirmed_slot": confirmed_slot,
        "slot_diff": slot_diff,
        "time_diff": time_diff,
        "priority_fee": priority_fee,
    }


def main():
    args = parse_args()

    results = []
    for i in range(args.runs):
        print(f"\nRun {i + 1}/{args.runs}")

        # Get fresh priority fee for each run
        print("\nGetting priority fee estimate...")
        priority_fee = asyncio.run(get_priority_fee())
        print(f"Priority fee: {priority_fee}")

        result = run_transfer(priority_fee)
        if result:
            results.append(result)
            print(json.dumps(result))
        else:
            print("Run failed, skipping...")

        # Add a small delay between runs
        if i < args.runs - 1:
            time.sleep(1)

    # Calculate averages
    if results:
        total_slot_diff = sum(r["slot_diff"] for r in results)
        total_time_diff = sum(r["time_diff"] for r in results)
        total_priority_fee = sum(r["priority_fee"] for r in results)
        num_successful_runs = len(results)

        # Calculate max and min slot differences
        max_slot_diff = max(r["slot_diff"] for r in results)
        min_slot_diff = min(r["slot_diff"] for r in results)

        averages = {
            "avg_slot_diff": total_slot_diff / num_successful_runs,
            "avg_time_diff": total_time_diff / num_successful_runs,
            "avg_priority_fee": total_priority_fee / num_successful_runs,
            "max_slot_diff": max_slot_diff,
            "min_slot_diff": min_slot_diff,
            "successful_runs": num_successful_runs,
            "total_runs": args.runs,
        }
    else:
        averages = {
            "avg_slot_diff": 0,
            "avg_time_diff": 0,
            "avg_priority_fee": 0,
            "max_slot_diff": 0,
            "min_slot_diff": 0,
            "successful_runs": 0,
            "total_runs": args.runs,
        }

    # Save results to JSON file
    output_data = {"results": results, "averages": averages}
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    filename = f"transfer_results_{timestamp}.json"

    with open(filename, "w") as f:
        json.dump(output_data, f, indent=2)

    print(f"\nResults saved to {filename}")
    print("\nFinal Results:")
    print(json.dumps(output_data, indent=2))


if __name__ == "__main__":
    main()
