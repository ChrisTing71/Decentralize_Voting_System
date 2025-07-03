import click
import json
import requests
import os
import base64
from abci_app.crypto_utils import CryptoUtils

# 預設路徑，與 run_node.py 保持一致
DEFAULT_CONFIG_DIR = "./config"
DEFAULT_DATA_DIR = "./data"
DEFAULT_PUBKEY_PATH = os.path.join(DEFAULT_CONFIG_DIR, "paillier_pubkey.json")
DEFAULT_SHARES_PATH = os.path.join(DEFAULT_CONFIG_DIR, "sss_shares.json")
DEFAULT_STATE_PATH = os.path.join(DEFAULT_DATA_DIR, "app_state.json")

def send_tx(tx_string: str, tendermint_rpc: str) -> bool:
    """輔助函式，用於向 Tendermint 廣播交易。"""
    # Tendermint RPC 要求交易需經 base64 編碼
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
        
        check_tx_result = res_json.get('result', {}).get('check_tx', {})
        deliver_tx_result = res_json.get('result', {}).get('deliver_tx', {})
        
        if check_tx_result.get('code', 0) != 0:
            click.echo(f"交易在 CheckTx 階段失敗: {check_tx_result.get('log')}")
            return False
        if deliver_tx_result.get('code', 0) != 0:
            click.echo(f"交易在 DeliverTx 階段失敗: {deliver_tx_result.get('log')}")
            return False
            
        click.echo("交易已成功提交並打包。")
        return True
    except requests.exceptions.RequestException as e:
        click.echo(f"無法連接至 Tendermint RPC ({tendermint_rpc}): {e}")
        return False

def query_state(tendermint_rpc: str) -> dict | None:
    """輔助函式，用於向 Tendermint 查詢應用程式狀態。"""
    payload = {
        "jsonrpc": "2.0",
        "id": -1,
        "method": "abci_query",
        "params": {"path": "/state"}
    }
    try:
        response = requests.post(tendermint_rpc, json=payload)
        response.raise_for_status()
        res_json = response.json()

        if 'error' in res_json:
            click.echo(f"Tendermint RPC 錯誤: {res_json['error']['data']}")
            return None
        
        query_result = res_json.get('result', {}).get('response', {})
        if query_result.get('code', 0) != 0:
            click.echo(f"查詢狀態失敗: {query_result.get('log')}")
            return None
        
        # Tendermint 回傳的 value 是 base64 編碼的
        state_b64 = query_result.get('value')
        if not state_b64:
            click.echo("查詢成功，但狀態為空。")
            return None
            
        state_json = base64.b64decode(state_b64).decode('utf-8')
        return json.loads(state_json)
    except requests.exceptions.RequestException as e:
        click.echo(f"無法連接至 Tendermint RPC ({tendermint_rpc}): {e}")
        return None

@click.group()
def cli():
    """一個用於管理去中心化投票系統的命令列工具。"""
    pass

@cli.command()
@click.option('--nodes', '-n', default=4, help='節點總數。')
@click.option('--threshold', '-t', default=3, help='還原私鑰所需的分片門檻數量。')
@click.option('--key-length', default=1024, help='Paillier 金鑰長度。')
def generate_keys(nodes, threshold, key_length):
    """產生 Paillier 金鑰對，並使用 SSS 切割私鑰。"""
    if not os.path.exists(DEFAULT_CONFIG_DIR):
        os.makedirs(DEFAULT_CONFIG_DIR)

    click.echo("正在產生 Paillier 金鑰對...")
    pubkey, privkey = CryptoUtils.generate_paillier_keys(key_length)
    
    with open(DEFAULT_PUBKEY_PATH, 'w') as f:
        f.write(CryptoUtils.public_key_to_json(pubkey))
    click.echo(f"公鑰已儲存至: {DEFAULT_PUBKEY_PATH}")

    click.echo(f"正在將私鑰切割成 {nodes} 份，門檻為 {threshold}...")
    shares = CryptoUtils.split_private_key(privkey, nodes, threshold)
    
    with open(DEFAULT_SHARES_PATH, 'w') as f:
        json.dump({'shares': shares, 'threshold': threshold}, f, indent=2)
    click.echo(f"私鑰分片已儲存至: {DEFAULT_SHARES_PATH}")
    click.echo("金鑰生成完畢！在真實世界中，請將 sss_shares.json 中的分片安全地分發給每個節點。")

@cli.command()
@click.option('--end-height', required=True, type=int, help='設定投票結束的區塊高度。')
def setup_genesis(end_height):
    """產生用於 Tendermint genesis.json 的 'app_state' JSON 字串。"""
    app_state = {"voting_end_height": end_height}
    app_state_json = json.dumps(app_state)
    click.echo("\n" + "="*60)
    click.echo("請將以下 'app_state' 內容複製到您的 genesis.json 檔案中：")
    click.echo(f'"app_state": {app_state_json}')
    click.echo("="*60 + "\n")

@cli.command()
@click.option('--tendermint-rpc', default='http://localhost:26657', help='Tendermint RPC 的 URL。')
def tally(tendermint_rpc):
    """開票程序：從鏈上查詢狀態、收集分片、還原私鑰、解密總票數並公布結果。"""
    if not all(os.path.exists(p) for p in [DEFAULT_SHARES_PATH, DEFAULT_PUBKEY_PATH]):
        click.echo("錯誤：缺少金鑰設定檔。請先執行 generate-keys。")
        return

    click.echo("正在從區塊鏈查詢最新狀態...")
    state = query_state(tendermint_rpc)
    if not state:
        click.echo("無法獲取鏈上狀態，開票中止。")
        return
    
    click.echo(f"成功獲取狀態 (區塊高度: {state.get('current_height')})。")

    # 檢查投票是否已根據鏈上狀態結束
    if state.get('voting_end_height', 0) == 0:
        click.echo("錯誤：投票結束高度未在鏈上設定。")
        return
    if state.get('current_height', 0) <= state.get('voting_end_height', 0):
        click.echo(f"投票尚未結束 (目前高度: {state.get('current_height')}, 結束高度: {state.get('voting_end_height')})。")
        return
    
    if state.get('final_result') is not None:
        click.echo("結果已經在鏈上公布，無需再次計票。")
        click.echo(f"鏈上結果: {state.get('final_result')}")
        return

    with open(DEFAULT_SHARES_PATH, 'r') as f:
        shares_data = json.load(f)
    click.echo(f"已載入 {len(shares_data['shares'])} 份分片，還原門檻為 {shares_data['threshold']}。")

    # 1. 載入公鑰，因為還原私鑰時需要它
    with open(DEFAULT_PUBKEY_PATH, 'r') as pkf:
        pubkey = CryptoUtils.public_key_from_json(pkf.read())

    # 2. 收集足夠的分片並還原私鑰
    try:
        # 使用門檻數量的分片和公鑰來還原
        shares_to_recover = shares_data['shares'][:shares_data['threshold']]
        privkey = CryptoUtils.recover_private_key(shares_to_recover, pubkey)
        click.echo("Paillier 私鑰已成功還原！")
    except Exception as e:
        click.echo(f"還原私鑰失敗: {e}")
        return

    # 3. 解密鏈上總和
    encrypted_sum_str = state.get('encrypted_sum')
    if not encrypted_sum_str:
        click.echo("錯誤：鏈上狀態中找不到加密總和。")
        return
    encrypted_sum = CryptoUtils.str_to_encrypted_number(encrypted_sum_str, pubkey)
    final_result = privkey.decrypt(encrypted_sum)
    click.echo("="*30 + "\n投票結果解密成功！")
    click.echo(f"總投票數: {state.get('total_votes', 0)}")
    click.echo(f"票數總和 (1=同意, 0=反對): {final_result}\n" + "="*30)

    click.echo("\n正在將最終結果廣播至區塊鏈...")
    result_string = f"Total Votes: {state.get('total_votes', 0)}, Sum: {final_result}"
    send_tx(f"result:{result_string}", tendermint_rpc)

if __name__ == "__main__":
    cli()