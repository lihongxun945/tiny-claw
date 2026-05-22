#!/usr/bin/env python3
"""
TEA Open API 客户端脚本

提供 TEA 平台 API 调用能力，包括：
- 鉴权管理（access_token 获取和缓存）
- 从链接提取 DSL
- 使用 DSL 查询数据
- 完整的数据获取流程

配置方式（优先级从高到低）：
1. 环境变量: TEA_APP_ID, TEA_APP_SECRET, TEA_USER
2. 配置文件: ~/.tea/config.json
"""

import argparse
import json
import sys
from typing import Any, Dict, Optional

# 支持直接运行脚本和模块导入两种方式
if __name__ == "__main__" and __package__ is None:
    import os
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from scripts.core import TEAClient, TEAConfig, TokenManager
    from scripts.dsl import DSLModifier
    from scripts.models import DSL
    from scripts.models.enums import Granularity, PropertyOperation, PropertyType
    from scripts.utils.date_utils import to_unix_timestamp
else:
    from .core import TEAClient, TEAConfig, TokenManager
    from .dsl import DSLModifier
    from .models import DSL
    from .models.enums import Granularity, PropertyOperation, PropertyType
    from .utils.date_utils import to_unix_timestamp


def format_output(data: Any, format_type: str = "json") -> str:
    """格式化输出数据"""
    if format_type == "json":
        if isinstance(data, dict):
            return json.dumps(data, indent=2, ensure_ascii=False)
        elif isinstance(data, list):
            return json.dumps(data, indent=2, ensure_ascii=False)
        else:
            return str(data)
    elif format_type == "csv":
        # 简单的 CSV 转换
        lines = []
        if isinstance(data, list):
            for item in data:
                query_id = item.get("query_id", "")
                for data_item in item.get("data_item_list", []):
                    show_name = data_item.get("show_name", "")
                    group_key = data_item.get("group_by_key", "")
                    dates = item.get("date_index_list", [])
                    values = data_item.get("data", [])

                    for date, value in zip(dates, values):
                        lines.append(f"{query_id},{show_name},{group_key},{date},{value}")

            return "query_id,show_name,group_by_key,date,value\n" + "\n".join(lines)
    return str(data)


def modify_period_dates(
    period: Dict[str, Any],
    start_date: Optional[str],
    end_date: Optional[str],
) -> Dict[str, Any]:
    """
    修改单个 period 的日期范围。

    参考 tea-query skill 的实现，使用 past_range 类型配合 timestamp 类型的 spans，
    而不是转换为 fixed 类型。
    """
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
                {
                    "type": "timestamp",
                    "timestamp": str(to_unix_timestamp(end_date, end_of_day=True)),
                },
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

    return period


def create_dsl_modifier(
    dsl_dict: Dict[str, Any],
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    granularity: Optional[str] = None,
    filters: Optional[list] = None,
    group_by: Optional[list] = None,
    limit: Optional[int] = None,
) -> Dict[str, Any]:
    """
    使用 DSLModifier 修改 DSL

    Args:
        dsl_dict: DSL 字典
        start_date: 开始日期
        end_date: 结束日期
        granularity: 时间粒度
        filters: 筛选条件列表
        group_by: 分组字段列表
        limit: 返回条数限制

    Returns:
        修改后的 DSL 字典
    """
    modifier = DSLModifier(dsl_dict)

    # 修改日期
    if start_date or end_date:
        modifier.modify_dates(start_date, end_date)

    # 修改粒度（如果用户指定了，会覆盖自动调整）
    if granularity:
        modifier.modify_granularity(granularity)

    # 添加筛选条件
    if filters:
        for f in filters:
            modifier.add_filter(
                property_name=f["property_name"],
                property_type=PropertyType(f.get("property_type", "event_param")),
                operation=PropertyOperation(f.get("operation", "=")),
                values=f["values"],
            )

    # 添加分组
    if group_by:
        for g in group_by:
            modifier.add_group_by(
                property_name=g["property_name"],
                property_type=PropertyType(g.get("property_type", "event_param")),
            )

    # 修改限制
    if limit:
        modifier.modify_limit(limit)

    # 输出粒度调整信息
    if modifier.has_granularity_changes():
        changes = modifier.get_granularity_changes()
        for change in changes:
            print(f"⚠️  时间粒度已自动调整: {change['old_granularity']} → {change['new_granularity']}")
            print(f"   原因: 查询 {change['start_date']} 至 {change['end_date']} 超出原粒度限制")

    return modifier.to_dict()


def main():
    parser = argparse.ArgumentParser(
        description="TEA Open API 客户端",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 从链接提取 DSL
  python3 tea_api.py extract --url "https://data.bytedance.net/tea-next/project/6/..."

  # 使用 DSL 文件查询数据
  python3 tea_api.py query --dsl-file dsl.json --output result.json

  # 完整流程：提取 DSL 并查询
  python3 tea_api.py fetch --url "https://data.bytedance.net/tea-next/project/6/..." --output data.json

  # 修改日期范围后查询（支持 fixed 和 past_range 类型）
  python3 tea_api.py fetch --url "..." --start-date 2026-03-01 --end-date 2026-03-25

  # 只修改开始日期
  python3 tea_api.py fetch --url "..." --start-date 2026-03-01

  # 只修改结束日期
  python3 tea_api.py fetch --url "..." --end-date 2026-03-25

  # 修改粒度
  python3 tea_api.py fetch --url "..." --granularity hour

  # 添加筛选条件（JSON 格式）
  python3 tea_api.py fetch --url "..." --filter '{"property_name":"os","operation":"=","values":["ios"]}'

  # 添加分组（JSON 格式）
  python3 tea_api.py fetch --url "..." --group-by '{"property_name":"os_name"}'

配置:
  环境变量: TEA_APP_ID, TEA_APP_SECRET, TEA_USER
  配置文件: ~/.tea/config.json

DSL 时间范围类型:
  fixed: 固定日期，如 {"type": "fixed", "start": "2026-03-01", "end": "2026-03-25"}
  past_range: 相对日期，如 {"type": "past_range", "spans": [{"type": "past", "past": {"amount": 14, "unit": "day"}}]}
        """,
    )

    subparsers = parser.add_subparsers(dest="command", help="可用命令")

    # extract 命令
    extract_parser = subparsers.add_parser("extract", help="从 TEA 链接提取 DSL")
    extract_parser.add_argument("--url", required=True, help="TEA 页面链接")
    extract_parser.add_argument("--output", "-o", help="输出文件路径")

    # query 命令
    query_parser = subparsers.add_parser("query", help="使用 DSL 查询数据")
    query_parser.add_argument("--dsl-file", required=True, help="DSL JSON 文件路径")
    query_parser.add_argument("--output", "-o", help="输出文件路径")
    query_parser.add_argument(
        "--format", "-f", choices=["json", "csv"], default="json", help="输出格式"
    )

    # fetch 命令
    fetch_parser = subparsers.add_parser(
        "fetch", help="完整流程：提取 DSL 并查询数据"
    )
    fetch_parser.add_argument("--url", required=True, help="TEA 页面链接")
    fetch_parser.add_argument("--output", "-o", help="输出文件路径")
    fetch_parser.add_argument(
        "--format", "-f", choices=["json", "csv"], default="json", help="输出格式"
    )
    fetch_parser.add_argument("--start-date", help="修改查询开始日期 (YYYY-MM-DD)")
    fetch_parser.add_argument("--end-date", help="修改查询结束日期 (YYYY-MM-DD)")
    fetch_parser.add_argument(
        "--granularity", "-g", help="修改查询粒度 (day/hour/minute 等)"
    )
    fetch_parser.add_argument(
        "--filter",
        action="append",
        help="添加筛选条件（JSON 格式，可多次使用）",
    )
    fetch_parser.add_argument(
        "--group-by",
        action="append",
        help="添加分组字段（JSON 格式，可多次使用）",
    )
    fetch_parser.add_argument("--limit", type=int, help="修改返回数据条数限制")
    fetch_parser.add_argument("--save-dsl", help="保存 DSL 到指定文件")

    # jumper 命令
    jumper_parser = subparsers.add_parser("jumper", help="从 DSL 生成 TEA 页面链接")
    jumper_parser.add_argument("--project-id", required=True, type=int, help="项目 ID")
    jumper_parser.add_argument("--dsl-file", required=True, help="DSL JSON 文件路径")
    jumper_parser.add_argument(
        "--query-type", default="event-analysis", help="查询类型 (默认: event-analysis)"
    )

    # config 命令
    config_parser = subparsers.add_parser("config", help="配置管理")
    config_parser.add_argument(
        "--init", action="store_true", help="交互式初始化配置"
    )
    config_parser.add_argument("--show", action="store_true", help="显示当前配置")
    config_parser.add_argument("--clear-cache", action="store_true", help="清除缓存")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    try:
        if args.command == "config":
            handle_config_command(args)
            return

        client = TEAClient()

        if args.command == "extract":
            dsl = client.extract_dsl(args.url)
            output = json.dumps(dsl, indent=2, ensure_ascii=False)

            if args.output:
                with open(args.output, "w") as f:
                    f.write(output)
                print(f"DSL 已保存到: {args.output}")
            else:
                print(output)

        elif args.command == "query":
            with open(args.dsl_file, "r") as f:
                dsl = json.load(f)

            result = client.query_analysis(dsl)
            output = format_output(result, args.format)

            if args.output:
                with open(args.output, "w") as f:
                    f.write(output)
                print(f"数据已保存到: {args.output}")
            else:
                print(output)

        elif args.command == "fetch":
            # 解析筛选条件和分组
            filters = None
            if args.filter:
                filters = [json.loads(f) for f in args.filter]

            group_by = None
            if args.group_by:
                group_by = [json.loads(g) for g in args.group_by]

            def modify_dsl(dsl_dict: Dict[str, Any]) -> Dict[str, Any]:
                """修改 DSL 参数"""
                # 使用新的 DSLModifier
                return create_dsl_modifier(
                    dsl_dict,
                    start_date=args.start_date,
                    end_date=args.end_date,
                    granularity=args.granularity,
                    filters=filters,
                    group_by=group_by,
                    limit=args.limit,
                )

            need_modify = any(
                [
                    args.start_date,
                    args.end_date,
                    args.granularity,
                    args.filter,
                    args.group_by,
                    args.limit,
                ]
            )

            dsl, result, tea_link = client.fetch_data(
                args.url, modify_dsl=modify_dsl if need_modify else None
            )

            # 保存 DSL
            if args.save_dsl:
                with open(args.save_dsl, "w") as f:
                    json.dump(dsl, f, indent=2, ensure_ascii=False)
                print(f"DSL 已保存到: {args.save_dsl}")

            # 格式化输出
            output = format_output(result, args.format)

            if args.output:
                with open(args.output, "w") as f:
                    f.write(output)
                print(f"数据已保存到: {args.output}")
            else:
                print(output)

            # 输出 TEA 链接供用户自查
            print(f"\nTEA 链接（可自查数据）: {tea_link}")

        elif args.command == "jumper":
            with open(args.dsl_file, "r") as f:
                dsl = json.load(f)

            url = client.generate_jumper_link(args.project_id, dsl, args.query_type)
            print(url)

    except Exception as e:
        print(f"错误: {e}", file=sys.stderr)
        sys.exit(1)


def handle_config_command(args):
    """处理 config 命令"""
    if args.init:
        TEAConfig.create_interactive()
    elif args.show:
        config = TEAConfig()
        print("当前配置:")
        print(f"  App ID: {config.app_id or '(未设置)'}")
        print(f"  User: {config.user or '(未设置)'}")
        print(f"  App Secret: {'*' * 8 if config.app_secret else '(未设置)'}")
        print(f"\n配置文件: {TEAConfig.CONFIG_FILE}")
    elif args.clear_cache:
        TEAConfig.clear_cache()
        print("缓存已清除")
    else:
        print("请指定操作: --init, --show, 或 --clear-cache")


if __name__ == "__main__":
    main()
