import json
from phe import paillier
import pyshamir

# 重新導出 phe 的類別，以保持與其他模組的 API 相容性
PaillierPublicKey = paillier.PaillierPublicKey
PaillierPrivateKey = paillier.PaillierPrivateKey
EncryptedNumber = paillier.EncryptedNumber

class CryptoUtils:
    """
    處理所有密碼學相關操作的工具類，包括 Paillier 加密和 Shamir 秘密分享。
    """

    @staticmethod
    def generate_paillier_keys(key_length: int = 1024):
        """
        產生一對 Paillier 公私鑰。
        """
        return paillier.generate_paillier_keypair(n_length=key_length)

    @staticmethod
    def split_private_key(private_key: paillier.PaillierPrivateKey, n: int, t: int):
        """
        使用 Shamir's Secret Sharing 將 Paillier 私鑰切割成 n 份。
        需要 t 份才能還原。
        """
        # --- 修正開始 ---
        
        # 1. 將 Paillier 私鑰的關鍵元件 p 和 q (大整數) 轉換成 bytes
        p_bytes = private_key.p.to_bytes((private_key.p.bit_length() + 7) // 8, 'big')
        q_bytes = private_key.q.to_bytes((private_key.q.bit_length() + 7) // 8, 'big')

        # 2. 使用正確的函式名稱 `split_secret` 來分割 bytes
        #    pyshamir 回傳的 shares 格式為 [(index, share_bytes), ...]
        p_shares_raw = pyshamir.split(p_bytes, n, t)
        q_shares_raw = pyshamir.split(q_bytes, n, t)

        # 3. 將 p 和 q 的分片配對。為了方便後續儲存或透過網路傳輸 (例如存成 JSON)，
        #    我們將 bytes 格式的 share 轉換成十六進位(hex)字串。
        combined_shares = []
        for i in range(n):
            combined_shares.append({
                "index": p_shares_raw[i][0],  # 儲存分片的索引，還原時需要
                "p_share": p_shares_raw[i][1].hex(),
                "q_share": q_shares_raw[i][1].hex()
            })
        return combined_shares
        # --- 修正結束 ---

    @staticmethod
    def recover_private_key(shares: list, public_key: paillier.PaillierPublicKey) -> paillier.PaillierPrivateKey:
        """
        從足夠數量的分片中還原 Paillier 私鑰。
        注意：這裡的 t (門檻值) 是隱含在 shares 的產生過程中的，我們只需要確認收到的 shares 數量足夠即可。
        """
        # --- 修正開始 ---

        # 1. 從傳入的 shares (裡面是 hex 字串) 重新組合 pyshamir 需要的格式
        #    格式為 [(index, share_bytes), ...]
        p_shares_to_recover = [(s['index'], bytes.fromhex(s['p_share'])) for s in shares]
        q_shares_to_recover = [(s['index'], bytes.fromhex(s['q_share'])) for s in shares]

        # 2. 使用正確的函式名稱 `recover_secret` 來還原成 bytes
        p_bytes = pyshamir.combine(p_shares_to_recover)
        q_bytes = pyshamir.combine(q_shares_to_recover)

        # 3. 將還原的 bytes 轉回整數
        p = int.from_bytes(p_bytes, 'big')
        q = int.from_bytes(q_bytes, 'big')
        
        # 4. 使用 p 和 q 以及原有的公鑰來重建私鑰物件
        #    直接傳入 public_key 可以確保 n 的一致性
        privkey = paillier.PaillierPrivateKey(public_key=public_key, p=p, q=q)
        return privkey
        # --- 修正結束 ---

    @staticmethod
    def public_key_to_json(public_key: paillier.PaillierPublicKey) -> str:
        return json.dumps({'n': public_key.n})

    @staticmethod
    def public_key_from_json(json_str: str) -> paillier.PaillierPublicKey:
        data = json.loads(json_str)
        return paillier.PaillierPublicKey(n=data['n'])

    @staticmethod
    def encrypted_number_to_str(enc_num: paillier.EncryptedNumber) -> str:
        return str(enc_num.ciphertext())

    @staticmethod
    def str_to_encrypted_number(s: str, public_key: paillier.PaillierPublicKey) -> paillier.EncryptedNumber:
        return paillier.EncryptedNumber(public_key, int(s))