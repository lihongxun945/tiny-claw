"""
测试自动调整时间粒度功能
"""
import pytest
from scripts.utils.date_utils import recommend_granularity, get_granularity_limit
from scripts.dsl import DSLModifier


class TestRecommendGranularity:
    """测试粒度推荐函数"""

    def test_get_granularity_limit(self):
        """测试获取粒度限制"""
        assert get_granularity_limit("minute") == 2
        assert get_granularity_limit("five_minute") == 2
        assert get_granularity_limit("hour") == 8
        assert get_granularity_limit("day") == 120
        assert get_granularity_limit("week") == 700
        assert get_granularity_limit("month") == 730
        assert get_granularity_limit("unknown") == 120  # 默认值

    def test_recommend_within_limit(self):
        """测试在限制范围内的日期"""
        # 1天，在hour粒度的8天限制内
        assert recommend_granularity("2026-01-01", "2026-01-02", "hour") == "hour"

        # 2天，在five_minute粒度的2天限制内
        assert recommend_granularity("2026-01-01", "2026-01-02", "five_minute") == "five_minute"

    def test_recommend_exceed_limit(self):
        """测试超过限制的日期"""
        # 7天，超过five_minute的2天限制，应该推荐hour
        assert recommend_granularity("2026-01-01", "2026-01-07", "five_minute") == "hour"

        # 10天，超过hour的8天限制，应该推荐day
        assert recommend_granularity("2026-01-01", "2026-01-10", "hour") == "day"

    def test_recommend_no_current_granularity(self):
        """测试没有指定当前粒度"""
        # 10天，应该推荐day粒度
        assert recommend_granularity("2026-01-01", "2026-01-10") == "day"

        # 200天，超过day的120天限制，应该推荐week
        assert recommend_granularity("2026-01-01", "2026-07-19") == "week"

    def test_recommend_edge_cases(self):
        """测试边界情况"""
        # 刚好等于限制
        assert recommend_granularity("2026-01-01", "2026-01-02", "five_minute") == "five_minute"
        assert recommend_granularity("2026-01-01", "2026-01-08", "hour") == "hour"
        assert recommend_granularity("2026-01-01", "2026-04-30", "day") == "day"

        # 超过所有限制，返回最大粒度
        assert recommend_granularity("2020-01-01", "2026-01-01", "minute") == "month"


class TestDSLModifierAutoGranularity:
    """测试DSLModifier的自动粒度调整"""

    def test_modify_dates_with_auto_adjust(self, sample_dsl_dict):
        """测试修改日期时自动调整粒度"""
        # 先修改DSL使用five_minute粒度
        dsl_dict = sample_dsl_dict.copy()
        dsl_dict["periods"][0]["granularity"] = "five_minute"

        modifier = DSLModifier(dsl_dict)

        # 修改为7天范围，当前是five_minute（仅支持2天）
        result = modifier.modify_dates("2026-01-01", "2026-01-07").build()

        # 检查是否有粒度调整记录
        assert modifier.has_granularity_changes() is True
        changes = modifier.get_granularity_changes()
        assert len(changes) == 1
        assert changes[0]["old_granularity"] == "five_minute"
        assert changes[0]["new_granularity"] == "hour"
        assert changes[0]["start_date"] == "2026-01-01"
        assert changes[0]["end_date"] == "2026-01-07"

        # 检查DSL中的粒度是否已更新
        assert result["periods"][0]["granularity"] == "hour"

    def test_modify_dates_disable_auto_adjust(self, sample_dsl_dict):
        """测试禁用自动调整"""
        # 先修改DSL使用five_minute粒度
        dsl_dict = sample_dsl_dict.copy()
        dsl_dict["periods"][0]["granularity"] = "five_minute"

        modifier = DSLModifier(dsl_dict)

        # 禁用自动调整
        result = modifier.modify_dates(
            "2026-01-01", "2026-01-07",
            auto_adjust_granularity=False
        ).build()

        # 不应有粒度调整
        assert modifier.has_granularity_changes() is False
        # 粒度应该保持不变
        assert result["periods"][0]["granularity"] == "five_minute"

    def test_modify_dates_no_need_to_adjust(self, sample_dsl_dict):
        """测试不需要调整的情况"""
        # 先修改DSL使用hour粒度
        dsl_dict = sample_dsl_dict.copy()
        dsl_dict["periods"][0]["granularity"] = "hour"

        modifier = DSLModifier(dsl_dict)

        # 修改为3天范围，在hour的8天限制内
        result = modifier.modify_dates("2026-01-01", "2026-01-03").build()

        # 不应有粒度调整
        assert modifier.has_granularity_changes() is False
        # 粒度应该保持不变
        assert result["periods"][0]["granularity"] == "hour"

    def test_modify_granularity_override_auto(self, sample_dsl_dict):
        """测试手动指定粒度覆盖自动调整"""
        # 先修改DSL使用five_minute粒度
        dsl_dict = sample_dsl_dict.copy()
        dsl_dict["periods"][0]["granularity"] = "five_minute"

        modifier = DSLModifier(dsl_dict)

        # 先自动调整
        modifier.modify_dates("2026-01-01", "2026-01-07")
        # 然后手动指定粒度
        modifier.modify_granularity("day")

        result = modifier.build()

        # 应该有调整记录
        assert modifier.has_granularity_changes() is True
        # 最终粒度应该是手动指定的
        assert result["periods"][0]["granularity"] == "day"
