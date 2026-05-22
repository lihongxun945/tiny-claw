"""
TEA API 客户端

封装 TEA 平台 API 调用，包括：
- 从链接提取 DSL
- 使用 DSL 查询数据
- 生成 TEA 页面链接
"""

import re
from typing import Any, Callable, Dict, Optional, Tuple, Union

import requests

from ..models.dsl import DSL
from ..models.response import APIResponse
from .auth import BASE_URL, TokenManager
from .config import TEAConfig

# API 端点
DSL_PATHS_ENDPOINT = "/dataopen/open-apis/datafinder/openapi/v1/projects/{project_id}/dsls/paths"
ANALYSIS_ENDPOINT = "/dataopen/open-apis/datafinder/openapi/v1/analysis"
JUMPER_ENDPOINT = "/dataopen/open-apis/datafinder/openapi/v1/projects/{project_id}/dsls/jumper"


class TEAClient:
    """
    TEA API 客户端

    提供完整的 TEA API 调用能力。
    """

    def __init__(self, config: Optional[TEAConfig] = None):
        """
        初始化客户端

        Args:
            config: TEA 配置对象，如果为 None 则自动加载
        """
        self.config = config or TEAConfig()
        if not self.config.validate():
            missing = self.config.get_missing_fields()
            raise Exception(
                f"缺少配置: {', '.join(missing)}。请设置环境变量或配置文件。"
            )
        self.token_manager = TokenManager(self.config)

    def _get_headers(self) -> Dict[str, str]:
        """获取请求头"""
        return {
            "Authorization": self.token_manager.get_token(),
            "X-REQUESTREALUSER": self.config.user,
            "Content-Type": "application/json",
        }

    def _extract_project_id(self, url: str) -> int:
        """
        从 URL 中提取 project_id

        Args:
            url: TEA 页面链接

        Returns:
            project_id

        Raises:
            ValueError: 无法提取 project_id
        """
        # 匹配 /project/{id}/ 或 /project/{id} 格式
        match = re.search(r"/project/(\d+)", url)
        if match:
            return int(match.group(1))
        raise ValueError(f"无法从 URL 中提取 project_id: {url}")

    def extract_dsl(self, url: str) -> Dict[str, Any]:
        """
        从 TEA 链接提取 DSL

        Args:
            url: TEA 页面链接

        Returns:
            DSL 字典
        """
        project_id = self._extract_project_id(url)
        endpoint = DSL_PATHS_ENDPOINT.format(project_id=project_id)

        response = requests.post(
            f"{BASE_URL}{endpoint}",
            headers=self._get_headers(),
            json={"path": url},
        )
        response.raise_for_status()
        data = response.json()

        if data.get("code") != 200:
            raise Exception(f"提取 DSL 失败: {data.get('message')}")

        # API 返回 {"dsl": {...}} 格式，提取实际的 DSL 对象
        result = data["data"]
        if "dsl" in result:
            return result["dsl"]
        return result

    def extract_dsl_model(self, url: str) -> DSL:
        """
        从 TEA 链接提取 DSL 并返回模型对象

        Args:
            url: TEA 页面链接

        Returns:
            DSL 模型对象
        """
        dsl_dict = self.extract_dsl(url)
        return DSL.from_dict(dsl_dict)

    def query_analysis(
        self, dsl: Union[Dict[str, Any], DSL]
    ) -> Dict[str, Any]:
        """
        使用 DSL 查询数据

        Args:
            dsl: DSL 字典或模型对象

        Returns:
            查询结果字典
        """
        if isinstance(dsl, DSL):
            dsl_dict = dsl.to_dict()
        else:
            dsl_dict = dsl

        response = requests.post(
            f"{BASE_URL}{ANALYSIS_ENDPOINT}",
            headers=self._get_headers(),
            json=dsl_dict,
        )
        response.raise_for_status()
        data = response.json()

        if data.get("code") != 200:
            raise Exception(f"查询失败: {data.get('message')}")

        return data["data"]

    def query_analysis_with_response(
        self, dsl: Union[Dict[str, Any], DSL]
    ) -> APIResponse:
        """
        使用 DSL 查询数据并返回响应模型

        Args:
            dsl: DSL 字典或模型对象

        Returns:
            APIResponse 模型对象
        """
        if isinstance(dsl, DSL):
            dsl_dict = dsl.to_dict()
        else:
            dsl_dict = dsl

        response = requests.post(
            f"{BASE_URL}{ANALYSIS_ENDPOINT}",
            headers=self._get_headers(),
            json=dsl_dict,
        )
        response.raise_for_status()
        data = response.json()

        return APIResponse.model_validate(data)

    def generate_jumper_link(
        self,
        project_id: int,
        dsl: Union[Dict[str, Any], DSL],
        query_type: str = "event-analysis",
    ) -> str:
        """
        从 DSL 生成 TEA 页面链接

        Args:
            project_id: 项目 ID
            dsl: DSL 字典或模型对象
            query_type: 查询类型

        Returns:
            TEA 页面链接
        """
        if isinstance(dsl, DSL):
            dsl_dict = dsl.to_dict()
        else:
            dsl_dict = dsl

        endpoint = JUMPER_ENDPOINT.format(project_id=project_id)

        response = requests.post(
            f"{BASE_URL}{endpoint}",
            headers=self._get_headers(),
            json={"query_type": query_type, "dsl": dsl_dict},
        )
        response.raise_for_status()
        data = response.json()

        if data.get("code") != 200:
            raise Exception(f"生成链接失败: {data.get('message')}")

        return data["data"].get("path", "")

    def fetch_data(
        self,
        url: str,
        modify_dsl: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]] = None,
    ) -> Tuple[Dict[str, Any], Dict[str, Any], str]:
        """
        完整流程：提取 DSL -> 可选修改 -> 查询数据

        Args:
            url: TEA 页面链接
            modify_dsl: 可选的 DSL 修改函数

        Returns:
            (dsl, query_result, tea_link) 元组
            - dsl: 修改后的 DSL 字典
            - query_result: 查询结果字典
            - tea_link: TEA 页面链接，用户可通过此链接自查数据
        """
        # 1. 提取 DSL
        dsl = self.extract_dsl(url)
        project_id = self._extract_project_id(url)

        # 2. 可选修改 DSL
        if modify_dsl:
            dsl = modify_dsl(dsl)

        # 3. 查询数据
        result = self.query_analysis(dsl)

        # 4. 生成 TEA 页面链接
        tea_link = self.generate_jumper_link(project_id, dsl)

        return dsl, result, tea_link

    def fetch_data_with_model(
        self,
        url: str,
        modify_dsl: Optional[Callable[[DSL], DSL]] = None,
    ) -> Tuple[DSL, APIResponse, str]:
        """
        完整流程（使用模型对象）：提取 DSL -> 可选修改 -> 查询数据

        Args:
            url: TEA 页面链接
            modify_dsl: 可选的 DSL 修改函数

        Returns:
            (DSL, APIResponse, tea_link) 元组
            - DSL: 修改后的 DSL 模型对象
            - APIResponse: 查询响应模型对象
            - tea_link: TEA 页面链接，用户可通过此链接自查数据
        """
        # 1. 提取 DSL
        dsl = self.extract_dsl_model(url)
        project_id = self._extract_project_id(url)

        # 2. 可选修改 DSL
        if modify_dsl:
            dsl = modify_dsl(dsl)

        # 3. 查询数据
        response = self.query_analysis_with_response(dsl)

        # 4. 生成 TEA 页面链接
        tea_link = self.generate_jumper_link(project_id, dsl)

        return dsl, response, tea_link
