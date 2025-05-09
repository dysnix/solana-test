from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solana.rpc.api import Client
from solana.rpc.commitment import Confirmed
from spl.token.client import Token
from spl.token.constants import TOKEN_PROGRAM_ID
from spl.token.instructions import get_associated_token_address
from solana.rpc.types import TxOpts

import time
import os
import json
import dotenv


dotenv.load_dotenv()

API_KEY = os.getenv("API_KEY")
USDT_MINT = Pubkey.from_string("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB")
RPC_URL = f"https://solana-rpc.rpcfast.net/trader?api_key={API_KEY}&tx_submit_mode=fastest&skip_preflight=true&tip_amount=1000000&mev_protect_level=low"

# Setup
client = Client(RPC_URL, commitment=Confirmed)
send_tx_client = Client(RPC_URL, commitment=Confirmed)

# Load keypair and define addresses
with open("sender_pk.json", "rb") as f:
    secret_key = json.load(f)
sender = Keypair.from_bytes(secret_key)
receiver_pubkey = os.getenv("RECEIVER_PUBLIC_KEY")

token = Token(client, USDT_MINT, TOKEN_PROGRAM_ID, sender)
sender_ata = get_associated_token_address(sender.pubkey(), USDT_MINT)
receiver_ata = get_associated_token_address(Pubkey.from_string(receiver_pubkey), USDT_MINT)

# Define amount
amount = 100_000 # 0.1 USDT

# Check if receiver's ATA exists
print("\nChecking receiver's Associated Token Account...")
try:
    receiver_ata_info = client.get_account_info(receiver_ata)
    if receiver_ata_info.value is None:
        print("Receiver's ATA doesn't exist. Creating it...")
        # Create receiver's ATA
        create_ata_tx = token.create_associated_token_account(Pubkey.from_string(receiver_pubkey))
        print(f"Create ATA transaction: {str(create_ata_tx)}")
        # Wait for ATA creation to confirm
        time.sleep(2)  # Give some time for the ATA to be created
    else:
        print("Receiver's ATA exists")
except Exception as e:
    print(f"Error checking receiver's ATA: {e}")
    exit(1)

# Check sender's token balance
print("\nChecking sender's token balance...")
try:
    sender_balance = token.get_balance(sender_ata)
    print(f"Sender's balance: {sender_balance.value.amount}")
    if int(sender_balance.value.amount) < amount:
        print(f"Error: Insufficient balance. Have: {sender_balance.value.amount}, Need: {amount}")
        exit(1)
except Exception as e:
    print(f"Error checking sender's balance: {e}")
    exit(1)

sender_ata = get_associated_token_address(sender.pubkey(), USDT_MINT)
receiver_ata = get_associated_token_address(Pubkey.from_string(receiver_pubkey), USDT_MINT)

# Fetch recent block info (before send)
pre_slot = client.get_slot(commitment=Confirmed).value
pre_slot_time = client.get_block_time(pre_slot).value

# Get recent blockhash
print("Getting recent blockhash...")
pre_block = client.get_latest_blockhash(commitment=Confirmed).value
recent_blockhash = pre_block.blockhash
print(f"Recent blockhash: {recent_blockhash}")
print(f"Current slot: {pre_slot}")

# Create and send transaction
print("\nCreating transfer transaction...")
print(f"From: {sender_ata}")
print(f"To: {receiver_ata}")
print(f"Amount: {amount}")

token = Token(send_tx_client, USDT_MINT, TOKEN_PROGRAM_ID, sender)
tx = token.transfer(
    source=sender_ata,
    dest=receiver_ata,
    owner=sender.pubkey(),
    amount=amount,
    recent_blockhash=recent_blockhash
)

print("\nSending transaction...")
signature = tx.value
print("Transaction Signature:", signature)

# Wait for confirmation
print("Waiting for confirmation...")
try:
    confirm_status = client.confirm_transaction(signature, commitment=Confirmed)
    if len(confirm_status.value) > 0:
        print(f"Transaction confirmed! {str(confirm_status.value[0])}")
    elif confirm_status.value[0].err is not None:
        print(f"Transaction failed: {confirm_status.value[0].err}")
        exit(1)
    else:
        print("Failed to wait for confirmation")
        exit(1)
except Exception as e:
    print(f"Error confirming transaction: {e}")
    exit(1)

# Get post-confirmation block info
confirmed_slot = confirm_status.value[0].slot
confirmed_time = client.get_block_time(confirmed_slot).value

# Compare
slot_diff = confirmed_slot - pre_slot
time_diff = confirmed_time - pre_slot_time

print(f"Transaction included in slot: {confirmed_slot}")
print(f"Slot difference: {slot_diff}")
print(f"Time difference: {time_diff} seconds")
