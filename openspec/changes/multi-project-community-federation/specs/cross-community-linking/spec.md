## ADDED Requirements

### Requirement: 出站 HTTP 依赖发现

系统 SHALL 在 `/understand` 分析过程中识别项目内的出站 HTTP 调用，提取 `domain`、`method`、`fullPath`（含 contextPath 合成），写入候选跨社区边。

#### Scenario: 完整 URL 调用

- **WHEN** 代码包含 `fetch("https://order.internal.com/order-api/orders/123")`
- **THEN** 系统提取 `domain=order.internal.com`、`method=GET`、`fullPath=/order-api/orders/{param}`

#### Scenario: baseUrl 加相对路径

- **WHEN** 配置 `order.url=https://api.company.com/order-api` 且代码请求 `/orders/123`
- **THEN** 系统合成 `fullPath=/order-api/orders/{param}`

---

### Requirement: 跨社区边匹配

系统 SHALL 使用 `domain + method + fullPath（归一化）` 在工作区 manifest 索引中匹配目标社区及具体节点。匹配成功时建立 `calls_community` 边，`communityMeta.status` 为 `resolved`。

#### Scenario: 唯一匹配成功

- **WHEN** `refund-service` 调用 `order.internal.com/order-api/orders/123` 且 `order-service` manifest 中有唯一匹配的 routeCatalog 条目
- **THEN** 建立从调用节点到 `order-service` 具体 `endpoint` 的 `calls_community` 边，`remoteRef` 包含 `serviceId`、`graphKind`、`nodeId`

#### Scenario: 共享域名通过 contextPath 消歧

- **WHEN** `api.company.com/order-api/orders/123` 和 `api.company.com/payment-api/pay/123` 分属不同项目
- **THEN** 系统通过 `contextPath` 前缀正确区分目标社区

---

### Requirement: 匹配失败标 ambiguous

当 `domain + fullPath` 无法唯一匹配到目标社区或具体节点时，系统 SHALL 将边标记为 `ambiguous`，SHALL NOT 自动选择候选。

#### Scenario: 多候选无法消歧

- **WHEN** 同一 `domain + fullPath` 匹配到多个项目的 routeCatalog 条目
- **THEN** 边的 `communityMeta.status` 为 `ambiguous`，分析报告中列出待确认项

#### Scenario: 无匹配目标

- **WHEN** 出站调用的 domain 在工作区 manifest 索引中无命中
- **THEN** 创建 `status=pending` 的 `community` 占位节点，边保留 `matchHints` 供后续回填

---

### Requirement: 全局限定节点引用

跨社区边的 `remoteRef` SHALL 使用三元组 `{ serviceId, graphKind, nodeId }` 标识远程节点，SHALL NOT 仅存储裸 `nodeId`。

#### Scenario: 不同项目相同 nodeId

- **WHEN** `refund-service` 和 `order-service` 均有 `endpoint:src/controller:handler`
- **THEN** 跨社区边的 `remoteRef.serviceId` 能唯一区分引用目标

---

### Requirement: placeholder 与双向 backfill

系统 SHALL 在每次 `/understand` 结束时执行跨社区链接解析步骤：

1. **正向**：解析当前项目的出站依赖，建立或更新跨社区边
2. **反向**：扫描工作区内其他项目的 `outbound-links.json`，凡引用当前 `serviceId` 的条目，使用当前项目新 manifest 回填

#### Scenario: 先分析调用方后分析被调用方

- **WHEN** 先分析 `refund-service`（引用 `order-service`），`order-service` 尚未分析
- **THEN** `refund-service` 图谱中 `order-service` 为 `pending` 占位节点

#### Scenario: 被调用方分析后自动回填

- **WHEN** 随后分析 `order-service` 完成
- **THEN** `refund-service` 中引用 `order-service` 的占位边更新为 `resolved`，指向具体 endpoint，无需重跑 `refund-service` 的 LLM 分析

#### Scenario: backfill 不自动 commit

- **WHEN** backfill 修改了兄弟项目 `.understand-anything/` 下的文件
- **THEN** 系统在当前项目分析报告中列出被修改的兄弟项目路径，不执行 git commit

---

### Requirement: outbound-links 持久化

系统 SHALL 在 `.understand-anything/outbound-links.json` 记录本项目的出站跨社区引用，供兄弟项目 backfill 时读取。

#### Scenario: 出站引用记录

- **WHEN** `refund-service` 分析发现对 `order-service` 的调用
- **THEN** `outbound-links.json` 包含对应 `matchHints` 和 `targetServiceId`

---

### Requirement: stale 边处理

当项目重新分析导致 `routeCatalog` 变化时，系统 SHALL 反向扫描引用该项目的兄弟项目，将不再匹配的 `resolved` 边标为 `stale`。

#### Scenario: contextPath 变更

- **WHEN** `order-service` 将 contextPath 从 `/order-api` 改为 `/api/order` 并重新分析
- **THEN** `refund-service` 中基于旧 path 的跨社区边标为 `stale`

---

### Requirement: 节点展示名解析

跨社区边 SHALL 主存储 `remoteRef` 指向结构图 `endpoint`。若目标项目存在 `domain-graph.json` 且能匹配对应 `flow`/`step`，系统 SHALL 额外填充 `remoteDisplayName` 供 Dashboard 展示。

#### Scenario: 有 domain-graph 时展示业务名

- **WHEN** 跨社区边指向 `order-service` 的 endpoint，且该服务有 `flow:query-order`
- **THEN** Dashboard 门户展示为「订单社区：查询订单」而非仅 endpoint 技术名

---

### Requirement: 路径归一化

系统 SHALL 在匹配前对路径进行归一化：合并多余斜杠、去除尾斜杠、将路径参数统一为 `{param}` 格式、忽略 query string。

#### Scenario: 路径参数归一化

- **WHEN** 出站 path 为 `/order-api/orders/123` 且 routeCatalog 为 `/order-api/orders/{id}`
- **THEN** 归一化后匹配成功
