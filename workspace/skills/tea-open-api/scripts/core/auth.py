"""
Token 管理器

管理 TEA API 的 access_token 生命周期，包括获取、缓存和自动续期。
"""

import json
import time
import stat
from typing import Optional

import requests

from .config import TEAConfig

# API 配置
BASE_URL = "https://data.bytedance.net"
AUTH_ENDPOINT = "/dataopen/open-apis/v1/authorization"


class TokenManager:
    """
    Access Token 管理器

    功能：
    - 自动获取 access_token
    - 本地缓存 token
    - 自动续期（提前 5 分钟过期）
    """

    def __init__(self, config: TEAConfig):
        """
        初始化 Token 管理器

        Args:
            config: TEA 配置对象
        """
        self.config = config
        self._token: Optional[str] = None
        self._expires_at: float = 0

    def _load_cached_token(self) -> bool:
        """从缓存加载 token"""
        cache_file = TEAConfig.TOKEN_CACHE_FILE

        if cache_file.exists():
            try:
                # 验证文件权限
                file_stat = cache_file.stat()
                if file_stat.st_mode & 0o777 != 0o600:
                    # 权限不正确，拒绝加载
                    return False

                with open(cache_file, "r") as f:
                    cache = json.load(f)

                # 提前 5 分钟过期，避免边界情况
                if cache.get("expires_at", 0) > time.time() + 300:
                    self._token = cache.get("token")
                    self._expires_at = cache.get("expires_at", 0)
                    return True
            except (json.JSONDecodeError, IOError):
                pass

        return False

    def _save_token_cache(self) -> None:
        """保存 token 到缓存（安全存储）"""
        cache_file = TEAConfig.TOKEN_CACHE_FILE
        cache_file.parent.mkdir(parents=True, exist_ok=True)

        with open(cache_file, "w") as f:
            json.dump(
                {
                    "token": self._token,
                    "expires_at": self._expires_at,
                },
                f,
            )

        # 设置安全权限
        cache_file.chmod(stat.S_IRUSR | stat.S_IWUSR)

    def _fetch_new_token(self) -> str:
        """获取新的 access_token"""
        url = f"{BASE_URL}{AUTH_ENDPOINT}"

        response = requests.post(
            url,
            json={
                "app_id": self.config.app_id,
                "app_secret": self.config.app_secret,
            },
        )
        response.raise_for_status()
        data = response.json()

        if data.get("code") != 200:
            raise Exception(f"获取 token 失败: {data.get('message')}")

        self._token = data["data"]["access_token"]
        # token 有效期 2 小时
        self._expires_at = time.time() + 7200
        self._save_token_cache()

        return self._token

    def get_token(self) -> str:
        """
        获取有效的 access_token

        Returns:
            access_token 字符串
        """
        # 尝试从缓存加载
        if self._load_cached_token():
            return self._token

        # 获取新 token
        return self._fetch_new_token()

    def invalidate(self) -> None:
        """使 token 失效"""
        self._token = None
        self._expires_at = 0

        cache_file = TEAConfig.TOKEN_CACHE_FILE
        if cache_file.exists():
            cache_file.unlink()

    @property
    def is_expired(self) -> bool:
        """检查 token 是否过期"""
        return time.time() >= self._expires_at - 300  # 提前 5 分钟判断

    @property
    def expires_in(self) -> int:
        """获取 token 剩余有效时间（秒）"""
        return max(0, int(self._expires_at - time.time()))
