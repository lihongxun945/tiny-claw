"""
DSL 修改器

提供链式 API 修改 DSL 参数，支持：
- 修改日期范围
- 修改时间粒度
- 添加/移除/清空筛选条件
- 添加/移除/清空分组字段
- 修改返回条数限制
"""

import json
from copy import deepcopy
from typing import Any, Dict, List, Optional, Union

from ..models.enums import Granularity, PeriodType, PropertyOperation, PropertyType
from ..utils.date_utils import to_unix_timestamp, recommend_granularity, from_unix_timestamp


class DSLModifier:
    """
    DSL 修改器

    提供链式 API 修改 DSL 参数。直接操作字典，避免 Pydantic 模型验证问题。

    示例:
        modified_dsl = (DSLModifier(dsl_dict)
            .modify_dates("2026-01-01", "2026-01-31")
            .add_filter("status", PropertyType.EVENT_PARAM, PropertyOperation.EQUAL, ["success"])
            .add_group_by("os_name", PropertyType.COMMON_PARAM)
            .modify_limit(1000)
            .to_dict())
    """

    def __init__(self, dsl: Union["DSL", Dict[str, Any]]):
        """
        初始化修改器

        Args:
            dsl: DSL 对象或字典
        """
        if isinstance(dsl, dict):
            self._dsl_dict = deepcopy(dsl)
        else:
            # 如果是 Pydantic 模型，转换为字典
            self._dsl_dict = dsl.to_dict()
        self._granularity_changes: List[Dict[str, str]] = []  # 记录粒度调整

    def modify_dates(
        self,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        period_index: int = 0,
        auto_adjust_granularity: bool = True,
    ) -> "DSLModifier":
        """
        修改查询日期范围（支持自动调整粒度）

        Args:
            start_date: 开始日期 (YYYY-MM-DD)
            end_date: 结束日期 (YYYY-MM-DD)
            period_index: period 索引（默认第一个）
            auto_adjust_granularity: 是否自动调整粒度（默认True）

        Returns:
            self，支持链式调用
        """
        periods = self._dsl_dict.get("periods", [])
        if period_index >= len(periods):
            return self

        period = periods[period_index]

        # 获取当前的日期范围
        current_start, current_end = self._get_period_dates(period)
        new_start = start_date or current_start
        new_end = end_date or current_end
        current_granularity = period.get("granularity")

        # 修改日期
        self._modify_period_dates(period, start_date, end_date)

        # 自动调整粒度
        if auto_adjust_granularity and new_start and new_end:
            recommended = recommend_granularity(new_start, new_end, current_granularity)
            if recommended != current_granularity:
                # 记录调整
                self._granularity_changes.append({
                    "period_index": period_index,
                    "old_granularity": current_granularity,
                    "new_granularity": recommended,
                    "start_date": new_start,
                    "end_date": new_end,
                })
                # 应用新粒度
                period["granularity"] = recommended

        return self

    def _get_period_dates(self, period: Dict[str, Any]) -> tuple[Optional[str], Optional[str]]:
        """从 period 中提取开始和结束日期"""
        period_type = period.get("type", "")

        if period_type == "fixed":
            return period.get("start"), period.get("end")
        elif period_type == "past_range":
            spans = period.get("spans", [])
            if len(spans) >= 2:
                start_span = spans[0]
                end_span = spans[1]
                if start_span.get("type") == "timestamp" and end_span.get("type") == "timestamp":
                    try:
                        start_ts = int(start_span.get("timestamp", 0))
                        end_ts = int(end_span.get("timestamp", 0))
                        if start_ts and end_ts:
                            return from_unix_timestamp(start_ts), from_unix_timestamp(end_ts)
                    except (ValueError, TypeError):
                        pass
        return None, None

    def get_granularity_changes(self) -> List[Dict[str, str]]:
        """获取粒度调整记录"""
        return self._granularity_changes

    def has_granularity_changes(self) -> bool:
        """是否有粒度调整"""
        return len(self._granularity_changes) > 0

    def _modify_period_dates(
        self, period: Dict[str, Any], start_date: Optional[str], end_date: Optional[str]
    ) -> None:
        """修改单个 period 的日期"""
        period_type = period.get("type", "")

        if period_type == "fixed":
            # 固定日期类型，直接修改
            if start_date:
                period["start"] = start_date
            if end_date:
                period["end"] = end_date
        elif period_type == "past_range":
            # 相对日期类型，使用 timestamp 类型的 spans
            if start_date and end_date:
                period["spans"] = [
                    {"type": "timestamp", "timestamp": str(to_unix_timestamp(start_date))},
                    {"type": "timestamp", "timestamp": str(to_unix_timestamp(end_date, end_of_day=True))},
                ]
            elif start_date:
                # 只有开始日期，修改第一个 span
                if "spans" in period and len(period["spans"]) > 0:
                    period["spans"][0] = {
                        "type": "timestamp",
                        "timestamp": str(to_unix_timestamp(start_date)),
                    }
            elif end_date:
                # 只有结束日期，修改第二个 span
                if "spans" in period and len(period["spans"]) > 1:
                    period["spans"][1] = {
                        "type": "timestamp",
                        "timestamp": str(to_unix_timestamp(end_date, end_of_day=True)),
                    }

    def modify_granularity(
        self, granularity: Union[Granularity, str], period_index: int = 0
    ) -> "DSLModifier":
        """
        修改查询粒度

        Args:
            granularity: 时间粒度
            period_index: period 索引

        Returns:
            self，支持链式调用
        """
        periods = self._dsl_dict.get("periods", [])
        if period_index < len(periods):
            if isinstance(granularity, str):
                granularity = Granularity(granularity)
            periods[period_index]["granularity"] = granularity.value
        return self

    def add_filter(
        self,
        property_name: str,
        property_type: PropertyType,
        operation: PropertyOperation,
        values: List[str],
        query_group_index: int = 0,
        query_index: int = 0,
    ) -> "DSLModifier":
        """
        添加筛选条件

        Args:
            property_name: 属性名称
            property_type: 属性类型
            operation: 操作符
            values: 值列表
            query_group_index: 查询组索引（默认第一个）
            query_index: 查询索引（默认第一个）

        Returns:
            self，支持链式调用
        """
        # 创建筛选条件
        filter_condition = {
            "property_type": property_type.value,
            "property_name": property_name,
            "property_compose_type": "origin",
            "property_operation": operation.value,
            "property_values": values,
        }

        # 获取目标查询
        content = self._dsl_dict.get("content", {})
        queries = content.get("queries", [])

        if (
            queries
            and len(queries) > query_group_index
            and len(queries[query_group_index]) > query_index
        ):
            query = queries[query_group_index][query_index]

            # 确保 filters 列表存在
            if "filters" not in query:
                query["filters"] = []

            # 创建筛选表达式结构
            filter_obj = {
                "expression": {
                    "logic": "and",
                    "conditions": [filter_condition],
                }
            }
            query["filters"].append(filter_obj)

        return self

    def remove_filter(
        self,
        property_name: str,
        query_group_index: int = 0,
        query_index: int = 0,
    ) -> "DSLModifier":
        """
        移除筛选条件

        Args:
            property_name: 属性名称
            query_group_index: 查询组索引
            query_index: 查询索引

        Returns:
            self，支持链式调用
        """
        content = self._dsl_dict.get("content", {})
        queries = content.get("queries", [])

        if (
            queries
            and len(queries) > query_group_index
            and len(queries[query_group_index]) > query_index
        ):
            query = queries[query_group_index][query_index]
            filters = query.get("filters", [])

            for f in filters:
                if "expression" in f:
                    self._remove_condition_from_expression(
                        f["expression"], property_name
                    )

        return self

    def _remove_condition_from_expression(
        self, expression: Dict[str, Any], property_name: str
    ) -> None:
        """从表达式中移除指定属性的条件"""
        if "conditions" in expression:
            expression["conditions"] = [
                c for c in expression["conditions"]
                if c.get("property_name") != property_name
            ]
        if "expressions" in expression:
            for sub_expr in expression["expressions"]:
                self._remove_condition_from_expression(sub_expr, property_name)

    def clear_filters(
        self, query_group_index: int = 0, query_index: int = 0
    ) -> "DSLModifier":
        """
        清空筛选条件

        Args:
            query_group_index: 查询组索引
            query_index: 查询索引

        Returns:
            self，支持链式调用
        """
        content = self._dsl_dict.get("content", {})
        queries = content.get("queries", [])

        if (
            queries
            and len(queries) > query_group_index
            and len(queries[query_group_index]) > query_index
        ):
            query = queries[query_group_index][query_index]
            query["filters"] = []

        return self

    def add_group_by(
        self,
        property_name: str,
        property_type: PropertyType,
        query_group_index: int = 0,
        query_index: int = 0,
    ) -> "DSLModifier":
        """
        添加分组字段

        Args:
            property_name: 属性名称
            property_type: 属性类型
            query_group_index: 查询组索引（默认第一个）
            query_index: 查询索引（默认第一个）

        Returns:
            self，支持链式调用
        """
        group_field = {
            "property_type": property_type.value,
            "property_name": property_name,
            "property_compose_type": "origin",
        }

        content = self._dsl_dict.get("content", {})
        queries = content.get("queries", [])

        if (
            queries
            and len(queries) > query_group_index
            and len(queries[query_group_index]) > query_index
        ):
            query = queries[query_group_index][query_index]

            # 确保 groups_v2 列表存在
            if "groups_v2" not in query:
                query["groups_v2"] = []

            # 检查是否已存在
            existing_names = [g.get("property_name") for g in query["groups_v2"]]
            if property_name not in existing_names:
                query["groups_v2"].append(group_field)

        return self

    def remove_group_by(
        self,
        property_name: str,
        query_group_index: int = 0,
        query_index: int = 0,
    ) -> "DSLModifier":
        """
        移除分组字段

        Args:
            property_name: 属性名称
            query_group_index: 查询组索引
            query_index: 查询索引

        Returns:
            self，支持链式调用
        """
        content = self._dsl_dict.get("content", {})
        queries = content.get("queries", [])

        if (
            queries
            and len(queries) > query_group_index
            and len(queries[query_group_index]) > query_index
        ):
            query = queries[query_group_index][query_index]
            query["groups_v2"] = [
                g for g in query.get("groups_v2", [])
                if g.get("property_name") != property_name
            ]

        return self

    def clear_group_by(
        self, query_group_index: int = 0, query_index: int = 0
    ) -> "DSLModifier":
        """
        清空分组字段

        Args:
            query_group_index: 查询组索引
            query_index: 查询索引

        Returns:
            self，支持链式调用
        """
        content = self._dsl_dict.get("content", {})
        queries = content.get("queries", [])

        if (
            queries
            and len(queries) > query_group_index
            and len(queries[query_group_index]) > query_index
        ):
            query = queries[query_group_index][query_index]
            query["groups_v2"] = []

        return self

    def modify_limit(self, limit: int) -> "DSLModifier":
        """
        修改返回数据条数限制

        Args:
            limit: 最大返回条数 (1-50000)

        Returns:
            self，支持链式调用
        """
        content = self._dsl_dict.get("content", {})
        if "page" not in content:
            content["page"] = {}
        content["page"]["limit"] = limit
        return self

    def modify_timezone(
        self, timezone: str, period_index: int = 0
    ) -> "DSLModifier":
        """
        修改时区

        Args:
            timezone: 时区 (如 Asia/Shanghai)
            period_index: period 索引

        Returns:
            self，支持链式调用
        """
        periods = self._dsl_dict.get("periods", [])
        if period_index < len(periods):
            periods[period_index]["timezone"] = timezone
        return self

    def add_resource(self, resource_id: str, resource_type: str = "app") -> "DSLModifier":
        """
        添加资源

        Args:
            resource_id: 资源 ID
            resource_type: 资源类型

        Returns:
            self，支持链式调用
        """
        if "resources" not in self._dsl_dict:
            self._dsl_dict["resources"] = []

        existing_ids = [r.get("id") for r in self._dsl_dict["resources"]]
        if resource_id not in existing_ids:
            self._dsl_dict["resources"].append({
                "id": resource_id,
                "type": resource_type
            })
        return self

    def remove_resource(self, resource_id: str) -> "DSLModifier":
        """
        移除资源

        Args:
            resource_id: 资源 ID

        Returns:
            self，支持链式调用
        """
        self._dsl_dict["resources"] = [
            r for r in self._dsl_dict.get("resources", [])
            if r.get("id") != resource_id
        ]
        return self

    def build(self) -> Dict[str, Any]:
        """
        构建并返回修改后的 DSL 字典

        Returns:
            修改后的 DSL 字典
        """
        return self._dsl_dict

    def to_dict(self) -> Dict[str, Any]:
        """
        转换为字典

        Returns:
            DSL 字典表示
        """
        return self._dsl_dict

    def to_json(self, **kwargs: Any) -> str:
        """
        转换为 JSON 字符串

        Args:
            **kwargs: 传递给 json.dumps 的参数

        Returns:
            JSON 字符串
        """
        return json.dumps(self._dsl_dict, ensure_ascii=False, **kwargs)
