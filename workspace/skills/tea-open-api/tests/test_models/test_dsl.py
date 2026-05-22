"""
DSL 数据模型测试

测试 DSL 模型的序列化、反序列化和验证功能。
"""

import json
import pytest
from pydantic import ValidationError

from scripts.models.dsl import (
    Content,
    DSL,
    Filter,
    FilterCondition,
    FilterExpression,
    GroupField,
    MeasureInfo,
    Page,
    Period,
    Query,
    Resource,
    Span,
)
from scripts.models.enums import (
    EventIndicator,
    EventType,
    Granularity,
    MeasureType,
    PeriodType,
    PropertyOperation,
    PropertyType,
    QueryType,
)


class TestSpan:
    """测试 Span 模型"""

    def test_timestamp_span(self):
        """测试 timestamp 类型的 span"""
        span = Span(type="timestamp", timestamp="1740787200")
        assert span.type == "timestamp"
        assert span.timestamp == "1740787200"

    def test_past_span(self):
        """测试 past 类型的 span"""
        span = Span(type="past", past={"amount": 7, "unit": "day"})
        assert span.type == "past"
        assert span.past == {"amount": 7, "unit": "day"}

    def test_invalid_timestamp_span(self):
        """测试无效的 timestamp span"""
        with pytest.raises(ValidationError):
            Span(type="timestamp")

    def test_invalid_past_span(self):
        """测试无效的 past span"""
        with pytest.raises(ValidationError):
            Span(type="past")


class TestPeriod:
    """测试 Period 模型"""

    def test_fixed_period(self):
        """测试 fixed 类型的 period"""
        period = Period(
            type=PeriodType.FIXED,
            start="2026-03-01",
            end="2026-03-25",
            granularity=Granularity.DAY,
        )
        assert period.type == PeriodType.FIXED
        assert period.start == "2026-03-01"
        assert period.end == "2026-03-25"

    def test_past_range_period(self):
        """测试 past_range 类型的 period"""
        period = Period(
            type=PeriodType.PAST_RANGE,
            granularity=Granularity.DAY,
            spans=[
                Span(type="timestamp", timestamp="1740787200"),
                Span(type="timestamp", timestamp="1741291199"),
            ],
        )
        assert period.type == PeriodType.PAST_RANGE
        assert len(period.spans) == 2

    def test_invalid_fixed_period(self):
        """测试无效的 fixed period"""
        with pytest.raises(ValidationError):
            Period(type=PeriodType.FIXED)

    def test_invalid_date_format(self):
        """测试无效的日期格式"""
        with pytest.raises(ValidationError):
            Period(type=PeriodType.FIXED, start="2026/03/01", end="2026-03-25")


class TestQuery:
    """测试 Query 模型"""

    def test_query_with_event_name(self):
        """测试使用 event_name 的查询"""
        query = Query(
            event_name="app_launch",
            event_type=EventType.ORIGIN,
            event_indicator=EventIndicator.EVENTS,
            show_name="总次数",
        )
        assert query.event_name == "app_launch"
        assert query.event_type == EventType.ORIGIN

    def test_query_with_event_id(self):
        """测试使用 event_id 的查询"""
        query = Query(
            event_id=123,
            event_type=EventType.ORIGIN,
            event_indicator=EventIndicator.EVENTS,
        )
        assert query.event_id == 123

    def test_query_missing_event(self):
        """测试缺少事件信息"""
        with pytest.raises(ValidationError):
            Query(event_type=EventType.ORIGIN, event_indicator=EventIndicator.EVENTS)

    def test_query_with_measure(self):
        """测试计算指标查询"""
        query = Query(
            event_name="app_launch",
            event_type=EventType.ORIGIN,
            event_indicator=EventIndicator.MEASURE,
            measure_info=MeasureInfo(
                measure_type=MeasureType.SUM,
                property_name="duration",
            ),
        )
        assert query.measure_info is not None
        assert query.measure_info.measure_type == MeasureType.SUM

    def test_query_missing_measure_info(self):
        """测试缺少 measure_info"""
        with pytest.raises(ValidationError):
            Query(
                event_name="app_launch",
                event_type=EventType.ORIGIN,
                event_indicator=EventIndicator.MEASURE,
            )


class TestFilterCondition:
    """测试 FilterCondition 模型"""

    def test_filter_condition(self):
        """测试筛选条件"""
        condition = FilterCondition(
            property_type=PropertyType.EVENT_PARAM,
            property_name="scene",
            property_operation=PropertyOperation.EQUAL,
            property_values=["template"],
        )
        assert condition.property_name == "scene"
        assert condition.property_operation == PropertyOperation.EQUAL

    def test_filter_condition_with_multiple_values(self):
        """测试多值筛选条件"""
        condition = FilterCondition(
            property_type=PropertyType.COMMON_PARAM,
            property_name="os_name",
            property_operation=PropertyOperation.IN,
            property_values=["ios", "android"],
        )
        assert len(condition.property_values) == 2


class TestDSLSerialization:
    """测试 DSL 序列化和反序列化"""

    def test_dsl_from_dict(self, sample_dsl_dict):
        """测试从字典创建 DSL"""
        dsl = DSL.from_dict(sample_dsl_dict)

        assert dsl.version == 3
        assert len(dsl.periods) == 1
        assert dsl.content.query_type == QueryType.EVENT

    def test_dsl_to_dict(self, sample_dsl):
        """测试 DSL 转换为字典"""
        dsl_dict = sample_dsl.to_dict()

        assert "version" in dsl_dict
        assert "periods" in dsl_dict
        assert "content" in dsl_dict

    def test_dsl_json_roundtrip(self, sample_dsl):
        """测试 JSON 序列化往返"""
        json_str = sample_dsl.to_json()
        dsl_from_json = DSL.from_json(json_str)

        assert dsl_from_json.version == sample_dsl.version
        assert len(dsl_from_json.periods) == len(sample_dsl.periods)

    def test_dsl_get_first_query(self, sample_dsl):
        """测试获取第一个查询"""
        query = sample_dsl.get_first_query()
        assert query is not None
        assert query.event_name == "app_launch"

    def test_dsl_get_first_period(self, sample_dsl):
        """测试获取第一个时间段"""
        period = sample_dsl.get_first_period()
        assert period is not None
        assert period.granularity == Granularity.DAY


class TestExtraFields:
    """测试额外字段处理"""

    def test_dsl_accepts_extra_fields(self, sample_dsl_dict):
        """测试 DSL 接受额外字段"""
        sample_dsl_dict["extra_field"] = "extra_value"
        dsl = DSL.from_dict(sample_dsl_dict)
        # 额外字段应该被接受
        assert dsl is not None
