# TEA Open API 参考文档

## 环境信息

- **生产环境域名**: `https://data.bytedance.net`
- **Context Path**: `/dataopen/open-apis/datafinder`

> **注意**: 所有指向 `data-va.tiktok-row.net` 或 `data-va.bytedance.net` 的旧 VA 环境域名已于 2026 年 4 月初下线。

## 鉴权

### 获取 AccessToken

**接口**: `POST /dataopen/open-apis/v1/authorization`

**请求体**:
```json
{
    "app_id": "YOUR_APP_ID",
    "app_secret": "YOUR_APP_SECRET"
}
```

**响应**:
```json
{
    "code": 200,
    "message": "success",
    "data": {
        "access_token": "1/Jzd9uacdDazt2VRkwkD0ynnaNCVtixYS",
        "expires_in": 7200
    }
}
```

- Token 有效期 2 小时，过期需重新获取

### 必备 HTTP Headers

| Header | 描述 | 示例 |
|--------|------|------|
| `Authorization` | access_token | `1/Jzd9uacdDazt2VRkwkD0ynnaNCVtixYS` |
| `X-REQUESTREALUSER` | 用户邮箱前缀（内部接口强制要求） | `hezhujun.knight` |
| `Content-Type` | 请求体格式 | `application/json` |

---

## 核心 API

### 1. extract_dsl_from_link

从 TEA-Next 页面链接提取查询 DSL。

**接口**: `POST /dataopen/open-apis/datafinder/openapi/v1/projects/{project_id}/dsls/paths`

**路径参数**:
- `project_id`: 项目 ID，从链接 path 中提取

**请求体**:
```json
{
    "path": "https://data.bytedance.net/tea-next/project/6/event-analysis/result/zade9fb4631e78f037d6d"
}
```

**响应**:
```json
{
    "code": 200,
    "message": "success",
    "data": {
        "version": 3,
        "resources": [...],
        "use_app_cloud_id": false,
        "periods": [...],
        "content": {...}
    }
}
```

**cURL 示例**:
```bash
curl --location 'https://data.bytedance.net/dataopen/open-apis/datafinder/openapi/v1/projects/6/dsls/paths' \
--header 'Authorization: YOUR_ACCESS_TOKEN' \
--header 'X-REQUESTREALUSER: your.name' \
--header 'Content-Type: application/json' \
--data '{
    "path": "https://data.bytedance.net/tea-next/project/6/event-analysis/result/zade9fb4631e78f037d6d"
}'
```

---

### 2. query_analysis_by_dsl

使用 DSL 对象执行查询获取分析数据。

**接口**: `POST /dataopen/open-apis/datafinder/openapi/v1/analysis`

**请求体**: 完整的 DSL JSON 对象

**响应**:
```json
{
    "code": 200,
    "message": "success",
    "data": [
        {
            "query_id": "a00:p00:c00:q00",
            "data_item_list": [
                {
                    "group_by_key": "",
                    "data": [100, 150, 200, ...],
                    "show_name": "事件发生次数"
                }
            ],
            "date_index_list": ["2026-03-01", "2026-03-02", "2026-03-03", ...]
        }
    ]
}
```

**响应字段解释**:

| 字段 | 描述 |
|------|------|
| `query_id` | 子查询标识，格式 `a00:pXX:c00:qYY`<br>- `qYY`: `content.queries` 数组索引<br>- `pXX`: `periods` 数组索引 |
| `data_item_list` | 实际数据数组<br>- 无分组：通常一个 item<br>- 有分组：每个分组一个 item<br>- 有对照组：每个对照组一个 item |
| `date_index_list` | 时间索引列表，与 `data` 数组一一对应 |

**cURL 示例**:
```bash
curl --location 'https://data.bytedance.net/dataopen/open-apis/datafinder/openapi/v1/analysis' \
--header 'Authorization: YOUR_ACCESS_TOKEN' \
--header 'X-REQUESTREALUSER: your.name' \
--header 'Content-Type: application/json' \
--data '@dsl.json'
```

---

### 3. generate_jumper_link

从 DSL 反向生成 TEA-Next 页面链接。

**接口**: `POST /dataopen/open-apis/datafinder/openapi/v1/projects/{project_id}/dsls/jumper`

**请求体**:
```json
{
    "query_type": "event-analysis",
    "dsl": { ... }
}
```

**响应**:
```json
{
    "code": 200,
    "message": "success",
    "data": {
        "url": "https://data.bytedance.net/tea-next/project/6/..."
    }
}
```

---

### 4. convert_dsl

在不同平台 DSL 格式之间转换。

**接口**: `POST /dataopen/open-apis/datafinder/openapi/v1/projects/{project_id}/dsls/convert`

**请求体**:
```json
{
    "source_type": "tea",
    "target_type": "tea-next",
    "query_type": "event-analysis",
    "source_dsl": "{...}"
}
```

---

## DSL 结构详解

### 完整 DSL 示例

```json
{
    "version": 3,
    "resources": [
        {
            "id": "app_id_123",
            "type": "app"
        }
    ],
    "use_app_cloud_id": false,
    "periods": [
        {
            "type": "fixed",
            "start": "2026-03-01",
            "end": "2026-03-25",
            "granularity": "day",
            "timezone": "Asia/Shanghai"
        }
    ],
    "content": {
        "queries": [
            {
                "event": {
                    "type": "custom",
                    "name": "app_launch"
                },
                "metrics": [
                    {
                        "type": "count",
                        "show_name": "事件发生次数"
                    }
                ],
                "group_by": [],
                "filter": {
                    "conditions": []
                }
            }
        ]
    },
    "page": {
        "limit": 1000,
        "offset": 0
    }
}
```

### 关键字段说明

#### periods（时间范围）

```json
{
    "type": "fixed",           // 固定时间范围
    "start": "2026-03-01",     // 开始日期
    "end": "2026-03-25",       // 结束日期
    "granularity": "day",      // 时间粒度: minute, hour, day, week, month
    "timezone": "Asia/Shanghai" // 时区
}
```

#### content.queries（查询配置）

```json
{
    "event": {
        "type": "custom",      // 事件类型
        "name": "app_launch"   // 事件名称
    },
    "metrics": [
        {
            "type": "count",   // 指标类型
            "show_name": "事件发生次数"
        }
    ],
    "group_by": [              // 分组字段
        {
            "field": "event_name",
            "show_name": "事件名称"
        }
    ],
    "filter": {                // 筛选条件
        "conditions": [
            {
                "field": "app_id",
                "op": "in",
                "value": ["12345"]
            }
        ]
    }
}
```

#### 常用筛选操作符

| 操作符 | 描述 | 示例 |
|--------|------|------|
| `in` | 包含于 | `{"op": "in", "value": ["a", "b"]}` |
| `not_in` | 不包含于 | `{"op": "not_in", "value": ["a"]}` |
| `=` | 等于 | `{"op": "=", "value": "a"}` |
| `!=` | 不等于 | `{"op": "!=", "value": "a"}` |
| `>` | 大于 | `{"op": ">", "value": 100}` |
| `>=` | 大于等于 | `{"op": ">=", "value": 100}` |
| `<` | 小于 | `{"op": "<", "value": 100}` |
| `<=` | 小于等于 | `{"op": "<=", "value": 100}` |
| `contains` | 包含 | `{"op": "contains", "value": "keyword"}` |
| `not_contains` | 不包含 | `{"op": "not_contains", "value": "keyword"}` |

---

## DSL 结构说明
（从 SKILL.md 移动而来）

### 顶层结构

```yaml
{
  "version": 3,             # DSL的版本，固定为3
  "app_ids": [],            # tea-next场景忽略
  "resources": [],          # tea-next场景必填
  "use_app_cloud_id": true, # 固定为true
  "periods": [{}],          # 查询时间段，支持多个
  "content": {},            # 具体的查询内容字段
  "option": {},             # 请求相关的选项参数
  "show_option": {}         # 前端展示使用，不影响查询结果
}
```

| 字段 | 类型 | 取值与含义 | 是否必须 |
|------|------|----------|---------|
| version | int | DSL的版本，固定为3 | true |
| resources | json数组 | project_ids为主站path中的项目id；subject_ids固定为1；app_ids不需要传 | true |
| use_app_cloud_id | boolean | 固定为true | true |
| periods | json数组 | 查询时间段，支持多个 | true |
| content | json | 具体的查询内容字段 | true |

### periods 字段（重要）

**目前 type 仅支持 `past_range` 类型**，表示既支持过去x天（周、月），又支持固定时间段。

#### 固定时间示例

```json
{
  "granularity": "day",
  "type": "past_range",
  "spans": [
    {
      "type": "timestamp",
      "timestamp": "1704729600"
    },
    {
      "type": "timestamp",
      "timestamp": "1705161599"
    }
  ],
  "timezone": "Asia/Shanghai",
  "week_start": 1
}
```

#### 过去7天示例

```json
{
  "granularity": "day",
  "type": "past_range",
  "spans": [
    {
      "type": "past",
      "past": {
        "amount": 7,
        "unit": "day"
      }
    },
    {
      "type": "past",
      "past": {
        "amount": 1,
        "unit": "day"
      }
    }
  ],
  "timezone": "Asia/Shanghai",
  "week_start": 1
}
```

#### periods 字段说明

| 字段 | 取值与含义 | 是否必须 |
|------|----------|---------|
| type | 时间范围类型。目前只支持 `past_range`，其他类型不保证接口正确性 | 否 |
| spans | type为past_range时有效。是一个list，传2个，第一个代表开始时间，第二个代表结束时间 | 是 |
| granularity | 时间粒度：all/second/minute/five_minute/hour/day/week/month/quarter/year | 否，默认all |
| timezone | 时间范围的时区 | 否，默认Asia/Shanghai |
| week_start | granularity为周时，可以指定周的起始日期 | 否，默认1 |
| align_unit | 对齐单元：all/five_minute/hour/day/week/month | 否 |

#### spans 字段说明

spans 是一个长度为2的数组，第一个代表开始时间，第二个代表结束时间。每个元素的结构：

**timestamp 类型（固定时间点）**:
```json
{
  "type": "timestamp",
  "timestamp": "1704729600"
}
```

**past 类型（相对时间）**:
```json
{
  "type": "past",
  "past": {
    "amount": 7,
    "unit": "day"
  }
}
```

### content 字段

```json
{
  "profile_groups_v2": [],    # 分组条件，只支持公共属性
  "profile_filters": [{}],    # 过滤条件
  "orders": [],               # 排序规则
  "query_type": "",           # 查询类型
  "queries": [[],[]],         # 查询，二维数组
  "option": {},               # 查询选项
  "page": {}                  # 查询分页，limit相关配置，offset不生效
}
```

#### query_type 支持的类型

- `event`: 事件查询
- `retention`: 留存查询
- `funnel`: 转化查询
- `path_find`: 用户路径查询
- `life_cycle`: 生命周期查询
- `event_topk`: topk查询
- `ltv`: LTV查询
- `behavior_attribution`: 归因查询
- `composition`: 成分查询
- `btm_path_explore`: 流量地图
- `btm_page_insight`: 来源去向/页面热图

#### queries 字段

```json
{
  "event_name": "any_event",
  "event_id": 1,
  "event_type": "origin",
  "show_name": "总次数",
  "groups_v2": [],
  "filters": [],
  "show_label": "A",
  "event_indicator": "events",
  "measure_info": {}
}
```

| 字段 | 类型 | 取值与含义 | 是否必须 |
|------|------|----------|---------|
| event_name | string | 事件名称 | event_name和event_id必须有一个 |
| event_type | string | 事件类型：origin/virtual/bav | 是 |
| groups_v2 | string数组 | 分组，只能取事件属性、事件公共属性 | 否 |
| filters | 数组 | 过滤条件 | 否 |
| event_indicator | string | 计算指标：events/event_users/uv_per_au/events_per_user/pv_per_au/measure | 是 |
| measure_info | json | 计算指标补充，在 event_indicator 为 measure 时使用 | 否 |

#### measure_info 字段

```json
{
  "measure_type": "sum",
  "property_name": "time"
}
```

| 字段 | 取值与含义 |
|------|----------|
| measure_type | SUM/AVG/MAX/MIN/PCT/DISTINCT/PER_USER/DISTINCT_USER_ATTR/COUNT_BY_DATE/PLAIN |
| property_name | 计算属性 |

### page 字段

```json
"page": {
  "limit": 50,
  "offset": 0
}
```

| 字段 | 类型 | 取值与含义 |
|------|------|----------|
| limit | int | 指定要返回的最大维度数据条数。默认为1000，最大支持50000 |
| offset | int | 注意：offset字段尚处于开发阶段，目前生产环境上无法生效 |

## 修改 DSL 参数
（从 SKILL.md 移动而来）

### 修改日期范围

**重要**: 修改日期时，必须保持 `type: "past_range"`，使用 `timestamp` 类型的 spans。

```bash
# 修改为固定日期范围（会自动将 spans 改为 timestamp 类型）
python3 scripts/tea_api.py fetch --url "TEA链接" --start-date 2026-03-01 --end-date 2026-03-25

# 只修改开始日期
python3 scripts/tea_api.py fetch --url "TEA链接" --start-date 2026-03-01

# 只修改结束日期
python3 scripts/tea_api.py fetch --url "TEA链接" --end-date 2026-03-25
```

**转换逻辑**：当用户指定了日期参数时，脚本会自动将 spans 转换为 `timestamp` 类型，保持 `type: "past_range"` 不变。

### 修改时间粒度

```bash
# 修改时间粒度为小时
python3 scripts/tea_api.py fetch --url "TEA链接" --granularity hour

# 支持的粒度: all/second/minute/five_minute/hour/day/week/month/quarter/year
```

### 添加筛选条件

使用 `--filter` 参数添加筛选条件（JSON 格式，可多次使用）：

```bash
# 添加单个筛选条件
python3 scripts/tea_api.py fetch --url "TEA链接" \
  --filter '{"property_name":"os","operation":"=","values":["ios"]}'

# 添加多个筛选条件（AND 关系）
python3 scripts/tea_api.py fetch --url "TEA链接" \
  --filter '{"property_name":"os","operation":"=","values":["ios"]}' \
  --filter '{"property_name":"app_version","operation":">=","values":["39.0.0"]}'
```

**筛选条件 JSON 格式**：
```json
{
  "property_name": "属性名称",
  "property_type": "event_param 或 common_param（可选，默认 event_param）",
  "operation": "操作符: =, !=, >, >=, <, <=, in, not_in, contains, not_contains",
  "values": ["值列表"]
}
```

### 添加分组字段

使用 `--group-by` 参数添加分组字段（JSON 格式，可多次使用）：

```bash
# 添加单个分组
python3 scripts/tea_api.py fetch --url "TEA链接" \
  --group-by '{"property_name":"os_name"}'

# 添加多个分组
python3 scripts/tea_api.py fetch --url "TEA链接" \
  --group-by '{"property_name":"os_name"}' \
  --group-by '{"property_name":"app_version"}'
```

**分组字段 JSON 格式**：
```json
{
  "property_name": "属性名称",
  "property_type": "event_param 或 common_param（可选，默认 event_param）"
}
```

### 修改返回条数限制

```bash
# 限制返回 100 条数据
python3 scripts/tea_api.py fetch --url "TEA链接" --limit 100
```

### 组合使用

```bash
# 组合使用多个修改参数
python3 scripts/tea_api.py fetch --url "TEA链接" \
  --start-date 2026-03-01 --end-date 2026-03-25 \
  --granularity day \
  --filter '{"property_name":"os","operation":"=","values":["ios"]}' \
  --group-by '{"property_name":"os_name"}' \
  --limit 1000 \
  --output data.json
```

---

## 边界与限制

### 支持的链接类型

- **TEA-Next**: 完全支持
- **旧版 TEA**: 需先通过 `convert_dsl` 转换

### 分页限制

- `page.limit`: 建议 ≤10000，避免超时
- `page.offset`: **当前不生效**，无法用于分页

### 时间粒度限制

| 粒度 | 最大查询长度 |
|------|-------------|
| `minute` | 7 天 |
| `hour` | 30 天 |
| `day` | 120 天 |
| `week` | 2 年 |
| `month` | 5 年 |

### 性能建议

- 避免过于复杂的 DSL（多层分组、大量过滤条件）
- 保持查询简洁，必要时拆分为多次查询
- 确认时区设置正确（`periods.timezone`）
