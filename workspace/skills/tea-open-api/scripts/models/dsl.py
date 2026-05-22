"""
TEA DSL 数据模型

使用 Pydantic V2 实现 DSL 数据结构，支持序列化、反序列化和数据验证。
"""

from typing import Any, Dict, List, Optional, Union
from pydantic import BaseModel, Field, field_validator, model_validator

from .enums import (
    EventIndicator,
    EventType,
    Granularity,
    MeasureType,
    PeriodType,
    PropertyOperation,
    PropertyType,
    QueryType,
)


class Span(BaseModel):
    """时间跨度"""
    type: str = Field(..., description="类型: timestamp 或 past")
    timestamp: Optional[str] = Field(None, description="Unix 时间戳（timestamp 类型）")
    offset: Optional[int] = Field(None, description="偏移秒数")
    past: Optional[Dict[str, Any]] = Field(None, description="相对时间配置（past 类型）")

    @model_validator(mode="after")
    def validate_span(self) -> "Span":
        """验证 span 配置"""
        if self.type == "timestamp" and not self.timestamp:
            raise ValueError("timestamp type requires timestamp field")
        if self.type == "past" and not self.past:
            raise ValueError("past type requires past field")
        return self


class Period(BaseModel):
    """查询时间段"""
    type: PeriodType = Field(PeriodType.PAST_RANGE, description="时间段类型")
    granularity: Granularity = Field(Granularity.DAY, description="时间粒度")
    timezone: str = Field("Asia/Shanghai", description="时区")
    week_start: Optional[int] = Field(1, description="周起始日（1=周一）")
    align_unit: Optional[str] = Field(None, description="对齐单元")
    spans: Optional[List[Span]] = Field(None, description="时间跨度（past_range 类型）")
    start: Optional[str] = Field(None, description="开始日期（fixed 类型，YYYY-MM-DD）")
    end: Optional[str] = Field(None, description="结束日期（fixed 类型，YYYY-MM-DD）")

    @model_validator(mode="after")
    def validate_period(self) -> "Period":
        """验证 period 配置"""
        if self.type == PeriodType.FIXED:
            if not self.start or not self.end:
                raise ValueError("fixed type requires start and end fields")
        elif self.type == PeriodType.PAST_RANGE:
            # past_range 类型可以有 spans，也可以没有（使用默认值）
            pass
        return self

    @field_validator("start", "end")
    @classmethod
    def validate_date_format(cls, v: Optional[str]) -> Optional[str]:
        """验证日期格式"""
        if v is None:
            return v
        import re
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", v):
            raise ValueError(f"Invalid date format: {v}, expected YYYY-MM-DD")
        return v


class Resource(BaseModel):
    """资源"""
    id: str = Field(..., description="资源 ID（app_id 或 project_id）")
    type: str = Field("app", description="资源类型")


class GroupField(BaseModel):
    """分组字段"""
    property_type: PropertyType = Field(..., description="属性类型")
    property_name: str = Field(..., description="属性名称")
    property_compose_type: str = Field("origin", description="组合类型: origin/virtual")
    number_group_type: Optional[int] = Field(None, description="数值分组类型")

    model_config = {
        "populate_by_name": True,
        "alias_generator": lambda field_name: field_name,
    }


class FilterCondition(BaseModel):
    """筛选条件"""
    property_type: PropertyType = Field(..., description="属性类型")
    property_name: str = Field(..., description="属性名称")
    property_compose_type: str = Field("origin", description="组合类型: origin/virtual")
    property_operation: PropertyOperation = Field(..., description="操作符")
    property_values: List[str] = Field(default_factory=list, description="值列表")

    model_config = {
        "populate_by_name": True,
    }


class FilterExpression(BaseModel):
    """筛选表达式（支持嵌套）"""
    logic: Optional[str] = Field("and", description="逻辑运算: and/or")
    expressions: Optional[List["FilterExpression"]] = Field(None, description="子表达式")
    conditions: Optional[List[FilterCondition]] = Field(None, description="条件列表")

    @model_validator(mode="after")
    def validate_expression(self) -> "FilterExpression":
        """验证表达式结构"""
        if self.expressions is None and self.conditions is None:
            raise ValueError("FilterExpression must have either expressions or conditions")
        return self


class Filter(BaseModel):
    """筛选器"""
    expression: Optional[FilterExpression] = Field(None, description="筛选表达式")


class MeasureInfo(BaseModel):
    """计算指标信息"""
    measure_type: MeasureType = Field(..., description="计算类型: SUM/AVG/MAX/MIN/PCT 等")
    property_name: str = Field(..., description="计算属性名称")
    percentiles: Optional[List[int]] = Field(None, description="百分位数（PCT 类型）")


class Query(BaseModel):
    """查询配置"""
    event_name: Optional[str] = Field(None, description="事件名称")
    event_id: Optional[int] = Field(None, description="事件 ID")
    event_type: EventType = Field(EventType.ORIGIN, description="事件类型: origin/virtual/bav")
    event_indicator: EventIndicator = Field(
        EventIndicator.EVENTS, description="指标类型: events/event_users/measure 等"
    )
    show_name: str = Field("", description="显示名称")
    show_label: str = Field("A", description="显示标签")
    groups_v2: List[GroupField] = Field(default_factory=list, description="分组字段")
    filters: List[Filter] = Field(default_factory=list, description="筛选条件")
    measure_info: Optional[MeasureInfo] = Field(None, description="计算指标信息")

    @model_validator(mode="after")
    def validate_event(self) -> "Query":
        """验证事件配置"""
        if not self.event_name and not self.event_id:
            raise ValueError("Either event_name or event_id is required")
        return self

    @model_validator(mode="after")
    def validate_measure(self) -> "Query":
        """验证计算指标配置"""
        if self.event_indicator == EventIndicator.MEASURE and not self.measure_info:
            raise ValueError("measure_info is required when event_indicator is 'measure'")
        return self


class Page(BaseModel):
    """分页配置"""
    limit: int = Field(1000, ge=1, le=50000, description="返回数据条数")
    offset: int = Field(0, ge=0, description="偏移量（暂不生效）")


class Order(BaseModel):
    """排序配置"""
    order_type: str = Field(..., description="排序类型")
    order_field: Optional[str] = Field(None, description="排序字段")
    order_direction: Optional[str] = Field("desc", description="排序方向: asc/desc")


class Content(BaseModel):
    """查询内容"""
    query_type: QueryType = Field(QueryType.EVENT, description="查询类型")
    queries: List[List[Query]] = Field(default_factory=list, description="查询配置（二维数组）")
    profile_filters: List[Dict[str, Any]] = Field(default_factory=list, description="用户属性筛选")
    profile_groups_v2: List[Dict[str, Any]] = Field(default_factory=list, description="用户属性分组")
    orders: List[Order] = Field(default_factory=list, description="排序配置")
    page: Page = Field(default_factory=Page, description="分页配置")
    option: Dict[str, Any] = Field(default_factory=dict, description="查询选项")


class DSL(BaseModel):
    """DSL 根模型"""
    version: int = Field(3, description="DSL 版本")
    resources: List[Resource] = Field(default_factory=list, description="资源列表")
    use_app_cloud_id: bool = Field(False, description="是否使用 app_cloud_id")
    periods: List[Period] = Field(default_factory=list, description="时间段配置")
    content: Content = Field(default_factory=Content, description="查询内容")
    option: Dict[str, Any] = Field(default_factory=dict, description="请求选项")
    show_option: Dict[str, Any] = Field(default_factory=dict, description="展示选项")
    page: Optional[Page] = Field(None, description="全局分页配置")

    model_config = {
        "extra": "allow",  # 允许额外字段
        "populate_by_name": True,
    }

    def to_json(self, **kwargs: Any) -> str:
        """序列化为 JSON 字符串"""
        return self.model_dump_json(by_alias=True, **kwargs)

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return self.model_dump()

    @classmethod
    def from_json(cls, json_str: str) -> "DSL":
        """从 JSON 字符串反序列化"""
        return cls.model_validate_json(json_str)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DSL":
        """从字典创建"""
        return cls.model_validate(data)

    def get_first_query(self) -> Optional[Query]:
        """获取第一个查询配置"""
        if self.content.queries and len(self.content.queries) > 0:
            if len(self.content.queries[0]) > 0:
                return self.content.queries[0][0]
        return None

    def get_first_period(self) -> Optional[Period]:
        """获取第一个时间段配置"""
        if self.periods:
            return self.periods[0]
        return None


# 更新 FilterExpression 的 forward reference
FilterExpression.model_rebuild()
