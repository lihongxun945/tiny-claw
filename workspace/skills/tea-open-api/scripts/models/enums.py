"""
TEA DSL 枚举类型定义

定义 DSL 中使用的各种枚举类型，提供类型安全和自动验证。
"""

from enum import Enum


class PeriodType(str, Enum):
    """时间段类型"""
    FIXED = "fixed"
    PAST_RANGE = "past_range"


class Granularity(str, Enum):
    """时间粒度"""
    ALL = "all"
    SECOND = "second"
    MINUTE = "minute"
    FIVE_MINUTE = "five_minute"
    HOUR = "hour"
    DAY = "day"
    WEEK = "week"
    MONTH = "month"
    QUARTER = "quarter"
    YEAR = "year"


class PropertyOperation(str, Enum):
    """筛选操作符"""
    IN = "in"
    NOT_IN = "not_in"
    EQUAL = "="
    NOT_EQUAL = "!="
    GREATER = ">"
    GREATER_EQUAL = ">="
    LESS = "<"
    LESS_EQUAL = "<="
    CONTAINS = "contains"
    NOT_CONTAINS = "not_contains"
    IS_NULL = "is_null"
    IS_NOT_NULL = "is_not_null"


class PropertyType(str, Enum):
    """属性类型"""
    EVENT_PARAM = "event_param"
    COMMON_PARAM = "common_param"


class EventType(str, Enum):
    """事件类型"""
    ORIGIN = "origin"
    VIRTUAL = "virtual"
    BAV = "bav"


class EventIndicator(str, Enum):
    """事件指标类型"""
    EVENTS = "events"  # 事件发生次数
    EVENT_USERS = "event_users"  # 事件 UV
    UV_PER_AU = "uv_per_au"  # 人均 UV
    EVENTS_PER_USER = "events_per_user"  # 人均事件数
    PV_PER_AU = "pv_per_au"  # 人均 PV
    MEASURE = "measure"  # 计算指标


class MeasureType(str, Enum):
    """计算指标类型"""
    SUM = "SUM"
    AVG = "AVG"
    MAX = "MAX"
    MIN = "MIN"
    PCT = "PCT"
    DISTINCT = "DISTINCT"
    PER_USER = "PER_USER"
    DISTINCT_USER_ATTR = "DISTINCT_USER_ATTR"
    COUNT_BY_DATE = "COUNT_BY_DATE"
    PLAIN = "PLAIN"


class QueryType(str, Enum):
    """查询类型"""
    EVENT = "event"
    RETENTION = "retention"
    FUNNEL = "funnel"
    PATH_FIND = "path_find"
    LIFE_CYCLE = "life_cycle"
    EVENT_TOPK = "event_topk"
    LTV = "ltv"
    BEHAVIOR_ATTRIBUTION = "behavior_attribution"
    COMPOSITION = "composition"
    BTM_PATH_EXPLORE = "btm_path_explore"
    BTM_PAGE_INSIGHT = "btm_page_insight"
