import json
from abci.application import BaseApplication, OkCode
from .state import VotingState
from .crypto_utils import CryptoUtils

# 交易前綴，用於區分不同類型的交易
TX_VOTE = "vote:"
TX_SETUP = "setup:"
TX_RESULT = "result:" # 用於在鏈上公布最終結果

class VotingApp(BaseApplication):
    """
    去中心化投票系統的 ABCI 應用程式。
    """
    def __init__(self, state: VotingState):
        self.state = state
        # 從持久化狀態中恢復
        self.current_height = self.state.current_height
        self.app_hash = self.state.get_app_hash() # 初始化 app_hash

    def info(self, req) -> dict:
        """Tendermint 連接時會呼叫此方法，回傳應用程式的最新狀態。"""
        return {
            "last_block_height": self.current_height,
            "last_block_app_hash": self.app_hash # 回傳真實的 app hash
        }

    def init_chain(self, req):
        """
        初始化區塊鏈時呼叫。
        從 genesis.json 中讀取 app_state 來設定投票結束高度。
        """
        app_state = json.loads(req.app_state_bytes)
        end_height = app_state.get("voting_end_height")
        if end_height:
            self.state.voting_end_height = int(end_height)
            print(f"投票系統初始化成功！投票將在區塊高度 {end_height} 結束。")
        self.state.save_state(self.current_height)
        return {}

    def query(self, req) -> dict:
        """
        處理來自客戶端的查詢請求。
        允許查詢應用程式的當前狀態。
        """
        path = req.path
        if path == "/state":
            state_dict = self.state.to_dict()
            state_json = json.dumps(state_dict).encode('utf-8')
            return {
                "code": OkCode,
                "value": state_json,
                "height": self.current_height,
                "log": f"Successfully queried state at height {self.current_height}"
            }
        
        return {
            "code": OkCode, "log": f"Unsupported query path: {path}"
        }

    def check_tx(self, tx: bytes) -> dict:
        """
        交易進入 memory pool 前的無狀態檢查。
        """
        tx_str = tx.decode('utf-8')
        
        if tx_str.startswith(TX_VOTE):
            parts = tx_str.split(':', 2)
            if len(parts) != 3:
                return {"code": OkCode, "log": "無效的投票交易格式。應為 'vote:uid:encrypted_vote'"}
            
            uid = parts[1]
            if not uid:
                return {"code": OkCode, "log": "UID 不可為空。"}

        elif tx_str.startswith(TX_RESULT):
            # 允許結果交易通過基本檢查
            pass
        else:
            return {"code": OkCode, "log": f"未知的交易類型: {tx_str[:20]}"}

        return {"code": OkCode}

    def deliver_tx(self, tx: bytes) -> dict:
        """
        交易被打包進區塊時呼叫，進行有狀態的檢查並更新狀態。
        """
        tx_str = tx.decode('utf-8')
        
        if self.state.is_voting_ended(self.current_height) and not tx_str.startswith(TX_RESULT):
            return {"code": OkCode, "log": f"投票已在區塊高度 {self.state.voting_end_height} 結束。只接受結果交易。"}

        if tx_str.startswith(TX_VOTE):
            parts = tx_str.split(':', 2)
            uid, encrypted_vote_str = parts[1], parts[2]

            if uid in self.state.voted_uids:
                return {"code": OkCode, "log": f"UID '{uid}' 已經投過票。"}

            try:
                encrypted_vote = CryptoUtils.str_to_encrypted_number(encrypted_vote_str, self.state.pubkey)
                self.state.add_vote(uid, encrypted_vote)
                print(f"成功處理來自 {uid} 的投票。目前總票數: {self.state.total_votes}")
            except Exception as e:
                return {"code": OkCode, "log": f"處理投票時發生錯誤: {e}"}

        elif tx_str.startswith(TX_RESULT):
            if self.state.final_result is not None:
                return {"code": OkCode, "log": "最終結果已經被公布，不可重複提交。"}
            
            # 投票必須結束才能公布結果
            if not self.state.is_voting_ended(self.current_height):
                 return {"code": OkCode, "log": f"投票尚未在區塊高度 {self.state.voting_end_height} 結束，無法公布結果。"}

            result = tx_str[len(TX_RESULT):]
            self.state.final_result = result
            print(f"最終結果已記錄到鏈上: {result}")

        return {"code": OkCode}

    def commit(self) -> dict:
        """
        將當前區塊的狀態變更持久化。
        """
        self.current_height += 1
        self.state.save_state(self.current_height)
        self.app_hash = self.state.get_app_hash() # 更新 app_hash
        return {"data": self.app_hash}