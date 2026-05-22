"""
pytest 配置和 fixtures

提供测试所需的共享配置和测试数据。
"""

import json
from pathlib import Path
from typing import Any, Dict

import pytest

# 测试数据目录
FIXTURES_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture
def sample_dsl_dict() -> Dict[str, Any]:
    """加载示例 DSL 字典"""
    with open(FIXTURES_DIR / "sample_dsl.json") as f:
        return json.load(f)


@pytest.fixture
def sample_response_dict() -> Dict[str, Any]:
    """加载示例响应字典"""
    with open(FIXTURES_DIR / "sample_response.json") as f:
        return json.load(f)


@pytest.fixture
def sample_dsl(sample_dsl_dict: Dict[str, Any]):
    """创建示例 DSL 模型实例"""
    from scripts.models.dsl import DSL

    return DSL.from_dict(sample_dsl_dict)


@pytest.fixture
def sample_response(sample_response_dict: Dict[str, Any]):
    """创建示例响应模型实例"""
    from scripts.models.response import APIResponse

    return APIResponse.model_validate(sample_response_dict)


@pytest.fixture
def fixed_period_dsl() -> Dict[str, Any]:
    """创建 fixed 类型的 period DSL"""
    return {
        "version": 3,
        "resources": [{"id": "app_id_123", "type": "app"}],
        "use_app_cloud_id": False,
        "periods": [
            {
                "type": "fixed",
                "start": "2026-03-01",
                "end": "2026-03-25",
                "granularity": "day",
                "timezone": "Asia/Shanghai",
            }
        ],
        "content": {
            "query_type": "event",
            "queries": [
                [
                    {
                        "event_name": "app_launch",
                        "event_type": "origin",
                        "event_indicator": "events",
                        "show_name": "总次数",
                        "show_label": "A",
                        "groups_v2": [],
                        "filters": [],
                    }
                ]
            ],
            "profile_filters": [],
            "profile_groups_v2": [],
            "orders": [],
            "page": {"limit": 1000, "offset": 0},
        },
    }


@pytest.fixture
def dsl_with_filters() -> Dict[str, Any]:
    """创建带筛选条件的 DSL"""
    return {
        "version": 3,
        "resources": [{"id": "app_id_123", "type": "app"}],
        "use_app_cloud_id": False,
        "periods": [
            {
                "type": "past_range",
                "granularity": "day",
                "timezone": "Asia/Shanghai",
                "spans": [
                    {"type": "timestamp", "timestamp": "1740787200"},
                    {"type": "timestamp", "timestamp": "1741291199"},
                ],
            }
        ],
        "content": {
            "query_type": "event",
            "queries": [
                [
                    {
                        "event_name": "app_launch",
                        "event_type": "origin",
                        "event_indicator": "events",
                        "show_name": "总次数",
                        "show_label": "A",
                        "groups_v2": [],
                        "filters": [
                            {
                                "expression": {
                                    "logic": "and",
                                    "expressions": [
                                        {
                                            "logic": "or",
                                            "conditions": [
                                                {
                                                    "property_type": "event_param",
                                                    "property_name": "scene",
                                                    "property_compose_type": "origin",
                                                    "property_operation": "=",
                                                    "property_values": ["template"],
                                                }
                                            ],
                                        }
                                    ],
                                }
                            }
                        ],
                    }
                ]
            ],
            "profile_filters": [],
            "profile_groups_v2": [],
            "orders": [],
            "page": {"limit": 1000, "offset": 0},
        },
    }
