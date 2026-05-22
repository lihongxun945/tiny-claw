"""
TEA API Response 数据模型

定义 API 响应的数据结构，支持序列化和反序列化。
"""

from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel, Field


class DataItem(BaseModel):
    """数据项"""
    group_by_key: str = Field("", description="分组键值")
    data: List[Union[int, float]] = Field(default_factory=list, description="数据值列表")
    show_name: str = Field("", description="显示名称")


class QueryResult(BaseModel):
    """查询结果"""
    query_id: str = Field(..., description="查询 ID，格式: a00:pXX:c00:qYY")
    data_item_list: List[DataItem] = Field(default_factory=list, description="数据项列表")
    date_index_list: List[str] = Field(default_factory=list, description="时间索引列表")

    def get_total_value(self, data_item_index: int = 0) -> Union[int, float]:
        """获取数据项的总值"""
        if data_item_index < len(self.data_item_list):
            return sum(self.data_item_list[data_item_index].data)
        return 0

    def get_average_value(self, data_item_index: int = 0) -> float:
        """获取数据项的平均值"""
        if data_item_index < len(self.data_item_list):
            data = self.data_item_list[data_item_index].data
            if data:
                return sum(data) / len(data)
        return 0.0


class APIResponse(BaseModel):
    """API 响应"""
    code: int = Field(..., description="响应码，200 表示成功")
    message: str = Field("success", description="响应消息")
    data: Union[List[QueryResult], Dict[str, Any]] = Field(
        default_factory=list, description="响应数据"
    )

    @property
    def is_success(self) -> bool:
        """判断响应是否成功"""
        return self.code == 200

    def get_results(self) -> List[QueryResult]:
        """获取查询结果列表"""
        if isinstance(self.data, list):
            return self.data
        return []

    def get_first_result(self) -> Optional[QueryResult]:
        """获取第一个查询结果"""
        results = self.get_results()
        return results[0] if results else None
