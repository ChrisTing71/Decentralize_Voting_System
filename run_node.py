import argparse
import os
from abci.server import ABCIServer
from abci_app.app import VotingApp
from abci_app.state import VotingState
from abci_app.crypto_utils import CryptoUtils

# 預設路徑
DEFAULT_DATA_DIR = "./data"
DEFAULT_CONFIG_DIR = "./config"
DEFAULT_STATE_PATH = os.path.join(DEFAULT_DATA_DIR, "app_state.json")
DEFAULT_PUBKEY_PATH = os.path.join(DEFAULT_CONFIG_DIR, "paillier_pubkey.json")

def main():
    parser = argparse.ArgumentParser(description="啟動投票系統的 ABCI 節點")
    parser.add_argument("--port", type=int, default=26658, help="ABCI 伺服器監聽的埠號")
    parser.add_argument("--state_file", type=str, default=DEFAULT_STATE_PATH, help="應用程式狀態檔案的路徑")
    parser.add_argument("--pubkey_file", type=str, default=DEFAULT_PUBKEY_PATH, help="Paillier 公鑰檔案的路徑")
    args = parser.parse_args()

    # 確保狀態檔案和設定檔的目錄存在
    for path in [args.state_file, args.pubkey_file]:
        dir_name = os.path.dirname(path)
        if dir_name and not os.path.exists(dir_name):
            os.makedirs(dir_name)
            print(f"已建立目錄: {dir_name}")

    # 載入公鑰
    if not os.path.exists(args.pubkey_file):
        print(f"錯誤: 找不到公鑰檔案 {args.pubkey_file}。")
        print("請先執行 'python scripts/admin_cli.py generate-keys' 來產生金鑰。")
        return
    with open(args.pubkey_file, 'r') as f:
        pubkey = CryptoUtils.public_key_from_json(f.read())
    
    # 初始化狀態和應用程式
    state = VotingState(state_file_path=args.state_file, pubkey=pubkey)
    app = VotingApp(state=state)
    
    # 啟動 ABCI 伺服器
    server = ABCIServer(app=app, port=args.port)
    print(f"ABCI 伺服器正在監聽 127.0.0.1:{args.port}...")
    server.run()

if __name__ == "__main__":
    main()