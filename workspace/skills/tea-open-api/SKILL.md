---
name: tea-open-api
description: 使用 TEA Open API 查询和分析 TEA 数据平台数据。**一定要在用户提到 TEA、数据分析、事件分析、或提供 data.bytedance.net/tea-next 链接时使用这个 skill，即使他们没有明确说要查询数据！** 当用户提供 TEA-Next 分析页面链接、需要查询事件分析数据、修改查询条件（日期、分组、筛选）、或从 TEA 获取数据时使用此 skill。触发词：TEA 链接、事件分析、数据查询、data.bytedance.net、tea-next、提取 DSL。
---

# TEA Open API

## Overview

此 skill 封装了 TEA (Thinking, Experiment, Analysis) 平台的开放能力，实现从 TEA-Next 分析页面链接到获取结构化数据的完整流程。支持提取查询逻辑（DSL）、修改查询参数、执行数据查询并保存结果。

## 重要提示

**所有命令必须使用 `python3` 而非 `python`**，因为代码使用了 Python 3 的类型注解语法。

```bash
# 正确
python3 scripts/tea_api.py fetch --url "TEA链接"

# 错误（可能指向 Python 2）
python scripts/tea_api.py fetch --url "TEA链接"
```

## 工作流程

```
用户提供 TEA 链接 → 提取 DSL → 修改 DSL（可选） → 查询数据 → 保存文件 → 总结分析
```

### 流程决策树

1. **用户提供 TEA 链接** → 使用 `extract_dsl_from_link` 提取 DSL
2. **用户需要修改查询** → 调整 DSL 中的参数（日期、分组、筛选条件）
3. **执行查询** → 使用 `query_analysis_by_dsl` 获取数据
4. **保存结果** → 将数据保存到 JSON/CSV 文件
5. **分析总结** → 根据用户需求解读数据

## 环境与鉴权

### 环境信息

- **生产环境域名**: `https://data.bytedance.net`
- **Context Path**: `/dataopen/open-apis/datafinder`

### 鉴权流程

所有 API 请求需要 `access_token`。使用 `scripts/tea_api.py` 脚本管理 token 生命周期。

**获取 AccessToken**:
```bash
POST /dataopen/open-apis/v1/authorization
{
    "app_id": "YOUR_APP_ID",
    "app_secret": "YOUR_APP_SECRET"
}
```

Token 有效期 2 小时，过期需重新获取。

### 必备 HTTP Headers

| Header | 描述 | 示例 |
|--------|------|------|
| `Authorization` | access_token | `1/Jzd9uacdDazt2VRkwkD0ynnaNCVtixYS` |
| `X-REQUESTREALUSER` | 用户邮箱前缀 | `your.name` |
| `Content-Type` | 请求体格式 | `application/json` |

## 核心 Actions

> **详细 API 文档请参考**: [references/api_reference.md](references/api_reference.md)

### 1. extract_dsl_from_link
从 TEA-Next 页面链接提取查询 DSL。

### 2. query_analysis_by_dsl
使用 DSL 对象执行查询获取数据。

### 3. generate_jumper_link
从 DSL 反向生成 TEA-Next 页面链接。

## 修改 DSL 参数（快速参考）

> **详细文档请参考**: [references/api_reference.md](references/api_reference.md)

### 常用命令速查

```bash
# 修改日期范围
python3 scripts/tea_api.py fetch --url "TEA链接" --start-date 2026-03-01 --end-date 2026-03-25

# 修改时间粒度
python3 scripts/tea_api.py fetch --url "TEA链接" --granularity hour

# 添加筛选条件
python3 scripts/tea_api.py fetch --url "TEA链接" \
  --filter '{"property_name":"os","operation":"=","values":["ios"]}'

# 添加分组
python3 scripts/tea_api.py fetch --url "TEA链接" \
  --group-by '{"property_name":"os_name"}'

# 限制返回条数
python3 scripts/tea_api.py fetch --url "TEA链接" --limit 100

# 组合使用
python3 scripts/tea_api.py fetch --url "TEA链接" \
  --start-date 2026-03-01 --end-date 2026-03-25 \
  --granularity day \
  --filter '{"property_name":"os","operation":"=","values":["ios"]}' \
  --group-by '{"property_name":"os_name"}' \
  --limit 1000 \
  --output data.json
```

**支持的粒度**: all/second/minute/five_minute/hour/day/week/month/quarter/year

**筛选操作符**: =, !=, >, >=, <, <=, in, not_in, contains, not_contains

## 使用脚本

### tea_api.py

核心脚本，处理 API 调用和鉴权：

```bash
# 提取 DSL
python3 scripts/tea_api.py extract --url "TEA链接"

# 执行查询
python3 scripts/tea_api.py query --dsl-file dsl.json --output result.json

# 完整流程
python3 scripts/tea_api.py fetch --url "TEA链接" --output data.json

# 修改日期后查询
python3 scripts/tea_api.py fetch --url "TEA链接" --start-date 2026-03-01 --end-date 2026-03-25 --output data.json

# 修改粒度
python3 scripts/tea_api.py fetch --url "TEA链接" --granularity hour

# 添加筛选条件
python3 scripts/tea_api.py fetch --url "TEA链接" \
  --filter '{"property_name":"os","operation":"=","values":["ios"]}'

# 添加分组
python3 scripts/tea_api.py fetch --url "TEA链接" \
  --group-by '{"property_name":"os_name"}'

# 修改返回条数
python3 scripts/tea_api.py fetch --url "TEA链接" --limit 100

# 组合使用
python3 scripts/tea_api.py fetch --url "TEA链接" \
  --start-date 2026-03-01 --end-date 2026-03-25 \
  --granularity day \
  --filter '{"property_name":"os","operation":"=","values":["ios"]}' \
  --group-by '{"property_name":"os_name"}' \
  --limit 1000 \
  --output data.json

# 保存修改后的 DSL
python3 scripts/tea_api.py fetch --url "TEA链接" \
  --start-date 2026-03-01 --end-date 2026-03-25 \
  --save-dsl modified_dsl.json

# 配置管理
python3 scripts/tea_api.py config --show     # 显示当前配置
python3 scripts/tea_api.py config --init      # 交互式初始化配置
python3 scripts/tea_api.py config --clear-cache  # 清除 token 缓存
```

### DSLModifier（编程接口）

如果需要在代码中修改 DSL，可以使用 `DSLModifier` 类：

```python
from scripts.dsl import DSLModifier
from scripts.models.enums import PropertyType, PropertyOperation, Granularity

# 从 DSL 字典创建修改器
modifier = DSLModifier(dsl_dict)

# 链式修改
modified_dsl = (modifier
    .modify_dates("2026-01-01", "2026-01-31")
    .modify_granularity(Granularity.DAY)
    .add_filter(
        property_name="status",
        property_type=PropertyType.EVENT_PARAM,
        operation=PropertyOperation.EQUAL,
        values=["success"]
    )
    .add_group_by(
        property_name="os_name",
        property_type=PropertyType.COMMON_PARAM
    )
    .modify_limit(1000)
    .build())

# 转换为字典或 JSON
dsl_dict = modified_dsl.to_dict()
json_str = modified_dsl.to_json()
```

### 配置管理

敏感信息（app_id、app_secret）通过环境变量或配置文件管理：

```bash
export TEA_APP_ID="your_app_id"
export TEA_APP_SECRET="your_app_secret"
export TEA_USER="your.email.prefix"
```

或创建 `~/.tea/config.json`：
```json
{
  "app_id": "your_app_id",
  "app_secret": "your_app_secret",
  "user": "your.email.prefix"
}
```

## 边界与限制

- **支持链接**: TEA-Next 链接，旧版 TEA 需先转换
- **分页限制**: `page.limit` 建议 ≤10000，`page.offset` 不生效
- **时间粒度**: `day` 最大 120 天；`hour` 最大 8 天；`five_minute` 最大 2 天
- **性能**: 复杂 DSL 可能超时，保持查询简洁
- **Python版本**: 必须使用 Python 3.x

## 自动时间粒度调整

### 功能说明

为了避免因时间粒度过细导致数据被截断，系统支持自动调整时间粒度功能。当您查询的日期范围超过当前粒度的限制时，系统会自动推荐并切换到更合适的粒度。

### 粒度限制

| 时间粒度 | 最大查询范围 |
|---------|------------|
| five_minute | 2天 |
| minute | 2天（与 five_minute 一致） |
| hour | 8天 |
| day | 120天 |
| week | 100周（约700天） |
| month | 24月（约730天） |

### 使用示例

```bash
# 查询最近7天，使用five_minute粒度（超过2天限制，会自动调整为hour）
python3 scripts/tea_api.py fetch --url "TEA链接" \
  --start-date 2026-03-01 --end-date 2026-03-07 \
  --granularity five_minute
```

系统会自动将粒度调整为 `hour` 并在输出中提示调整信息：
```
⚠️  时间粒度已自动调整: five_minute → hour
   原因: 查询 2026-03-01 至 2026-03-07 超出原粒度限制
```

### 编程接口

```python
from scripts.dsl import DSLModifier

modifier = DSLModifier(dsl_dict)
modified_dsl = modifier.modify_dates("2026-01-01", "2026-01-07").build()

# 检查是否有粒度调整
if modifier.has_granularity_changes():
    changes = modifier.get_granularity_changes()
    for change in changes:
        print(f"粒度已从 {change['old_granularity']} 调整为 {change['new_granularity']}")

# 禁用自动调整（如果需要保持原粒度）
modified_dsl = modifier.modify_dates(
    "2026-01-01", "2026-01-07",
    auto_adjust_granularity=False
).build()
```

## Resources

### scripts/

- `tea_api.py`: 核心 API 调用脚本，处理鉴权、DSL 提取、数据查询
- `models/`: 数据模型模块（Pydantic V2）
  - `enums.py`: 枚举类型定义
  - `dsl.py`: DSL 数据模型
  - `response.py`: API 响应模型
- `core/`: 核心功能模块
  - `config.py`: 配置管理
  - `auth.py`: Token 管理
  - `client.py`: API 客户端
- `dsl/`: DSL 操作模块
  - `modifier.py`: DSL 修改器（链式 API）
- `utils/`: 工具函数
  - `date_utils.py`: 日期处理工具

### tests/

- `test_models/`: 数据模型测试
- `test_dsl/`: DSL 修改器测试
- `fixtures/`: 测试数据

### references/

- `api_reference.md`: 完整 API 文档，包含所有接口细节和响应格式

## 依赖

- `requests>=2.28.0`: HTTP 请求库
- `pydantic>=2.0.0`: 数据验证和序列化
- `pytest>=7.0.0`: 测试框架（开发依赖）
