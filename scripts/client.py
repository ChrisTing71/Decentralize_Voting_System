import click
import requests
import os
import base64
import uuid
from abci_app.crypto_utils import CryptoUtils

# 預設路徑
DEFAULT_CONFIG_DIR = "./config"
DEFAULT_PUBKEY_PATH = os.path.join(DEFAULT_CONFIG_DIR, "paillier_pubkey.json")

def send_tx(tx_string: str, tendermint_rpc: str) -> bool:
    """輔助函式，用於向 Tendermint 廣播交易。"""
    tx_b64 = base64.b64encode(tx_string.encode('utf-8')).decode('utf-8')
    payload = {
        "jsonrpc": "2.0",
        "id": -1,
        "method": "broadcast_tx_commit",
        "params": {"tx": tx_b64}
    }
    try:
        response = requests.post(tendermint_rpc, json=payload)
        response.raise_for_status()
        res_json = response.json()
        
        if 'error' in res_json:
            click.echo(f"Tendermint RPC 錯誤: {res_json['error']['data']}")
            return False

        result = res_json.get('result', {})
        check_tx_result = result.get('check_tx', {})
        deliver_tx_result = result.get('deliver_tx', {})

        if check_tx_result.get('code', 0) != 0:
            click.echo(f"投票失敗 (驗證階段): {check_tx_result.get('log')}")
            return False
        if deliver_tx_result.get('code', 0) != 0:
            click.echo(f"投票失敗 (執行階段): {deliver_tx_result.get('log')}")
            return False
            
        click.echo(f"投票成功！交易雜湊值: {result.get('hash')}")
        return True
    except requests.exceptions.RequestException as e:
        click.echo(f"無法連接至 Tendermint RPC ({tendermint_rpc}): {e}")
        return False

@click.command()
@click.option('--uid', default=lambda: str(uuid.uuid4()), help="選民的唯一識別碼。預設為隨機 UUID。")
@click.option('--vote', type=click.Choice(['1', '0']), required=True, help="您的選票 (1 代表 '同意', 0 代表 '反對')。")
@click.option('--tendermint-rpc', default='http://localhost:26657', help='Tendermint RPC 的 URL。')
def cast_vote(uid, vote, tendermint_rpc):
    """加密您的選票並將其發送到區塊鏈。"""
    if not os.path.exists(DEFAULT_PUBKEY_PATH):
        click.echo(f"錯誤: 找不到公鑰檔案 {DEFAULT_PUBKEY_PATH}。請確認管理員已初始化系統。")
        return

    with open(DEFAULT_PUBKEY_PATH, 'r') as f:
        pubkey = CryptoUtils.public_key_from_json(f.read())
    
    click.echo(f"正在為 UID '{uid}' 的選票 '{vote}' 進行加密...")
    encrypted_vote = pubkey.encrypt(int(vote))
    send_tx(f"vote:{uid}:{CryptoUtils.encrypted_number_to_str(encrypted_vote)}", tendermint_rpc)

if __name__ == "__main__":
    cast_vote()