"""
日期处理工具函数

提供日期转换和验证功能。
"""

from datetime import datetime, timezone
from typing import Optional


def to_unix_timestamp(date_str: str, end_of_day: bool = False) -> int:
    """
    将 YYYY-MM-DD 格式转换为 Unix 时间戳（UTC）

    Args:
        date_str: 日期字符串 (YYYY-MM-DD)
        end_of_day: 是否设置为当天结束时间 (23:59:59)

    Returns:
        Unix 时间戳（秒）
    """
    d = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    if end_of_day:
        d = d.replace(hour=23, minute=59, second=59)
    return int(d.timestamp())


def from_unix_timestamp(timestamp: int) -> str:
    """
    将 Unix 时间戳转换为 YYYY-MM-DD 格式

    Args:
        timestamp: Unix 时间戳（秒）

    Returns:
        日期字符串 (YYYY-MM-DD)
    """
    dt = datetime.fromtimestamp(timestamp, tz=timezone.utc)
    return dt.strftime("%Y-%m-%d")


def validate_date_range(
    start_date: str, end_date: str, granularity: str = "day"
) -> bool:
    """
    验证日期范围是否符合粒度限制

    Args:
        start_date: 开始日期 (YYYY-MM-DD)
        end_date: 结束日期 (YYYY-MM-DD)
        granularity: 时间粒度

    Returns:
        是否有效
    """
    # 各粒度对应的最大天数限制
    limits = {
        "minute": 6,
        "five_minute": 2,
        "hour": 8,
        "day": 120,
        "week": 730,  # 2年
        "month": 1825,  # 5年
    }

    start = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")
    days = (end - start).days

    max_days = limits.get(granularity, 120)
    return days <= max_days


def get_date_range_days(start_date: str, end_date: str) -> int:
    """
    获取日期范围的天数

    Args:
        start_date: 开始日期 (YYYY-MM-DD)
        end_date: 结束日期 (YYYY-MM-DD)

    Returns:
        天数
    """
    start = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")
    return (end - start).days + 1


def format_date_for_display(date_str: str) -> str:
    """
    格式化日期用于显示

    Args:
        date_str: 日期字符串 (YYYY-MM-DD)

    Returns:
        格式化后的日期字符串
    """
    d = datetime.strptime(date_str, "%Y-%m-%d")
    return d.strftime("%Y年%m月%d日")


def parse_relative_date(amount: int, unit: str) -> tuple[str, str]:
    """
    解析相对日期，返回具体的日期范围

    Args:
        amount: 数量
        unit: 单位 (day/week/month)

    Returns:
        (开始日期, 结束日期) 元组
    """
    from datetime import timedelta

    now = datetime.now(timezone.utc)
    end_date = now.strftime("%Y-%m-%d")

    if unit == "day":
        start = now - timedelta(days=amount)
    elif unit == "week":
        start = now - timedelta(weeks=amount)
    elif unit == "month":
        # 简化处理，按30天计算
        start = now - timedelta(days=amount * 30)
    else:
        start = now - timedelta(days=amount)

    start_date = start.strftime("%Y-%m-%d")
    return start_date, end_date


def get_granularity_limit(granularity: str) -> int:
    """
    获取指定粒度的最大天数限制

    Args:
        granularity: 时间粒度

    Returns:
        最大天数限制
    """
    limits = {
        "minute": 2,
        "five_minute": 2,
        "hour": 8,
        "day": 120,
        "week": 700,  # 100周
        "month": 730,  # 24个月
    }
    return limits.get(granularity, 120)


def recommend_granularity(start_date: str, end_date: str, current_granularity: Optional[str] = None) -> str:
    """
    根据日期范围自动推荐合适的时间粒度

    从当前粒度开始，向更粗的粒度查找，找到第一个能满足日期范围限制的粒度。
    如果当前粒度已经满足要求，则返回当前粒度。

    Args:
        start_date: 开始日期 (YYYY-MM-DD)
        end_date: 结束日期 (YYYY-MM-DD)
        current_granularity: 当前使用的粒度（可选）

    Returns:
        推荐的时间粒度
    """
    # 粒度优先级（从细到粗）
    granularity_order = [
        "minute",
        "five_minute",
        "hour",
        "day",
        "week",
        "month",
    ]

    # 计算日期范围天数
    start = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")
    days = (end - start).days + 1  # 包含起止日期

    # 如果当前粒度存在且满足要求，直接返回
    if current_granularity and current_granularity in granularity_order:
        limit = get_granularity_limit(current_granularity)
        if days <= limit:
            return current_granularity

    # 从最细的粒度开始，找到第一个满足要求的
    for gran in granularity_order:
        limit = get_granularity_limit(gran)
        if days <= limit:
            return gran

    # 如果都不满足，返回最大的粒度
    return granularity_order[-1]
