"""
TEA 配置管理

管理 TEA API 的认证配置，支持环境变量和配置文件两种方式。
"""

import json
import os
import stat
from pathlib import Path
from typing import ClassVar, List, Optional

from pydantic import BaseModel


class TEAConfig(BaseModel):
    """
    TEA 配置管理

    支持两种配置方式：
    1. 环境变量: TEA_APP_ID, TEA_APP_SECRET, TEA_USER
    2. 配置文件: ~/.tea/config.json

    优先级：环境变量 > 配置文件
    """

    app_id: Optional[str] = None
    app_secret: Optional[str] = None
    user: Optional[str] = None

    # 配置文件路径（类属性）
    CONFIG_DIR: ClassVar[Path] = Path.home() / ".tea"
    CONFIG_FILE: ClassVar[Path] = CONFIG_DIR / "config.json"
    TOKEN_CACHE_FILE: ClassVar[Path] = CONFIG_DIR / "token_cache.json"

    def __init__(self, **data):
        super().__init__(**data)
        self._load_config()
        self._ensure_secure_permissions()

    def _load_config(self) -> None:
        """加载配置（优先级：环境变量 > 配置文件）"""
        # 从环境变量加载（最安全）
        self.app_id = os.environ.get("TEA_APP_ID", self.app_id)
        self.app_secret = os.environ.get("TEA_APP_SECRET", self.app_secret)
        self.user = os.environ.get("TEA_USER", self.user)

        # 从配置文件加载（如果环境变量未设置）
        if self.CONFIG_FILE.exists():
            try:
                with open(self.CONFIG_FILE, "r") as f:
                    config = json.load(f)
                self.app_id = self.app_id or config.get("app_id")
                self.app_secret = self.app_secret or config.get("app_secret")
                self.user = self.user or config.get("user")
            except (json.JSONDecodeError, IOError):
                pass

    def _ensure_secure_permissions(self) -> None:
        """确保配置文件权限安全"""
        for file_path in [self.CONFIG_FILE, self.TOKEN_CACHE_FILE]:
            if file_path.exists():
                try:
                    # 设置文件权限为仅所有者可读写 (600)
                    file_path.chmod(stat.S_IRUSR | stat.S_IWUSR)
                except OSError:
                    pass

        # 确保配置目录权限安全 (700)
        if self.CONFIG_DIR.exists():
            try:
                self.CONFIG_DIR.chmod(stat.S_IRWXU)
            except OSError:
                pass

    def save_config(self) -> None:
        """保存配置到文件"""
        self.CONFIG_DIR.mkdir(parents=True, exist_ok=True)

        config_data = {
            "app_id": self.app_id,
            "app_secret": self.app_secret,
            "user": self.user,
        }

        with open(self.CONFIG_FILE, "w") as f:
            json.dump(config_data, f, indent=2)

        # 设置安全权限
        self.CONFIG_FILE.chmod(stat.S_IRUSR | stat.S_IWUSR)

    def validate(self) -> bool:
        """验证配置是否完整"""
        return all([self.app_id, self.app_secret, self.user])

    def get_missing_fields(self) -> List[str]:
        """获取缺失的配置字段"""
        missing = []
        if not self.app_id:
            missing.append("app_id")
        if not self.app_secret:
            missing.append("app_secret")
        if not self.user:
            missing.append("user")
        return missing

    @classmethod
    def clear_cache(cls) -> None:
        """清除所有缓存和配置文件"""
        for file_path in [cls.CONFIG_FILE, cls.TOKEN_CACHE_FILE]:
            if file_path.exists():
                file_path.unlink()

    @classmethod
    def create_interactive(cls) -> "TEAConfig":
        """交互式创建配置"""
        print("TEA API 配置向导")
        print("=" * 40)

        app_id = input("请输入 App ID: ").strip()
        app_secret = input("请输入 App Secret: ").strip()
        user = input("请输入用户名（邮箱前缀）: ").strip()

        config = cls(app_id=app_id, app_secret=app_secret, user=user)
        config.save_config()

        print(f"\n配置已保存到: {cls.CONFIG_FILE}")
        return config
