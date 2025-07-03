import json
import os
import hashlib
from .crypto_utils import CryptoUtils, PaillierPublicKey, EncryptedNumber

class VotingState:
    """
    管理投票應用程式的狀態，並在 commit 時持久化到檔案。
    """
    def __init__(self, state_file_path: str, pubkey: PaillierPublicKey):
        self.state_file_path = state_file_path
        self.pubkey = pubkey
        self.voted_uids = set()
        self.encrypted_sum = self.pubkey.encrypt(0) # 初始化加密總和為 0
        self.total_votes = 0
        self.voting_end_height = 0 # 0 表示投票尚未設定結束高度
        self.current_height = 0
        self.final_result = None
        self.load_state()

    def load_state(self):
        """從檔案載入狀態。"""
        if os.path.exists(self.state_file_path):
            with open(self.state_file_path, 'r') as f:
                state_data = json.load(f)
                self.voted_uids = set(state_data.get('voted_uids', []))
                self.total_votes = state_data.get('total_votes', 0)
                self.voting_end_height = state_data.get('voting_end_height', 0)
                self.final_result = state_data.get('final_result', None)
                self.current_height = state_data.get('current_height', 0)
                
                encrypted_sum_str = state_data.get('encrypted_sum')
                if encrypted_sum_str:
                    self.encrypted_sum = CryptoUtils.str_to_encrypted_number(encrypted_sum_str, self.pubkey)
                else:
                    self.encrypted_sum = self.pubkey.encrypt(0)

    def to_dict(self):
        """將當前狀態序列化為字典。"""
        return {
            'voted_uids': list(self.voted_uids),
            'encrypted_sum': CryptoUtils.encrypted_number_to_str(self.encrypted_sum),
            'total_votes': self.total_votes,
            'voting_end_height': self.voting_end_height,
            'current_height': self.current_height,
            'final_result': self.final_result,
        }

    def get_app_hash(self) -> bytes:
        """計算並回傳當前狀態的雜湊值。"""
        # 使用穩定排序的 JSON 字串來確保雜湊值的一致性
        state_str = json.dumps(self.to_dict(), sort_keys=True).encode('utf-8')
        return hashlib.sha256(state_str).digest()

    def save_state(self, height: int):
        """將當前狀態儲存到檔案。"""
        self.current_height = height
        state_data = self.to_dict()
        with open(self.state_file_path, 'w') as f:
            json.dump(state_data, f, indent=2)

    def is_voting_ended(self, current_height: int) -> bool:
        """檢查投票是否已經結束。"""
        if self.voting_end_height == 0:
            return False # 如果未設定結束高度，則投票永遠不會結束
        return current_height > self.voting_end_height

    def add_vote(self, uid: str, encrypted_vote: EncryptedNumber):
        self.voted_uids.add(uid)
        self.encrypted_sum += encrypted_vote # phe 的同態加法是透過密文加法實現
        self.total_votes += 1