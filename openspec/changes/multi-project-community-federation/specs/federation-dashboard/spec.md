## ADDED Requirements

### Requirement: 联邦社区鸟瞰图

Dashboard SHALL 在工作区模式下提供联邦社区视图，仅展示 `community` 节点及社区间聚合边，不展开任何项目内部结构。

#### Scenario: 工作区联邦视图

- **WHEN** 用户从工作区根启动 Dashboard 且工作区内有 3 个已分析项目
- **THEN** 联邦视图显示 3 个社区节点及它们之间的跨社区调用关系

#### Scenario: 聚合边显示

- **WHEN** `refund-service` 有 3 处调用 `order-service`
- **THEN** 联邦视图中 `refund → order` 显示为一条聚合边，标注调用次数

#### Scenario: 占位社区显示

- **WHEN** 某社区尚未分析（manifest 不存在）
- **THEN** 联邦视图中该社区以虚线或特殊样式显示为 pending 状态

---

### Requirement: 单社区门户展示

Dashboard 在单项目模式下 SHALL 在跨社区边或门户节点旁展示「外社区：外节点」格式，不渲染外部社区的完整子图。

#### Scenario: 门户边展示

- **WHEN** 用户在 `refund-service` Dashboard 中查看「查询退费」节点的跨社区引用
- **THEN** 展示为「订单社区：查询订单详情」，不展开 `order-service` 内部节点

#### Scenario: pending 门户展示

- **WHEN** 引用的外部社区尚未分析
- **THEN** 展示为「订单社区（待分析）」

#### Scenario: ambiguous 门户展示

- **WHEN** 跨社区边 status 为 `ambiguous`
- **THEN** 边以警告样式显示，提示无法唯一匹配

---

### Requirement: Dashboard 双启动模式

系统 SHALL 支持两种 Dashboard 启动模式：

1. **单社区模式**：`GRAPH_DIR` 指向项目目录，加载该项目 `knowledge-graph.json` 及跨社区门户边
2. **联邦模式**：`UNDERSTAND_WORKSPACE_ROOT` 指向工作区根，加载联邦聚合图

#### Scenario: 单社区模式启动

- **WHEN** 用户在 `refund-service` 目录执行 `pnpm dev:dashboard`
- **THEN** Dashboard 加载 `refund-service` 图谱并显示跨社区门户边

#### Scenario: 联邦模式启动

- **WHEN** 用户设置 `UNDERSTAND_WORKSPACE_ROOT` 并从工作区根启动 Dashboard
- **THEN** Dashboard 默认显示联邦社区视图，可切换到具体子项目

---

### Requirement: 联邦图数据端点

Dashboard dev server SHALL 在工作区模式下提供 `/federation-graph.json` 端点，运行时聚合各项目 `community-manifest.json` 与 `outbound-links.json` 生成联邦图。

#### Scenario: 联邦 JSON 端点

- **WHEN** Dashboard 以联邦模式运行
- **THEN** 前端可通过 `/federation-graph.json` 获取社区节点与聚合边数据

---

### Requirement: 跨项目 manifest 只读访问

Dashboard dev server SHALL 允许在单社区模式下只读访问工作区内兄弟项目的 `community-manifest.json`（用于获取 `remoteDisplayName`），SHALL NOT 提供兄弟项目的源码文件访问。

#### Scenario: 读取兄弟 manifest 获取展示名

- **WHEN** `refund-service` Dashboard 需要展示 `order-service` 的远程节点名称
- **THEN** server 只读加载 `order-service/.understand-anything/community-manifest.json`

#### Scenario: 禁止跨项目源码访问

- **WHEN** 用户在 `refund-service` Dashboard 中点击跨社区门户边
- **THEN** 系统不展示 `order-service` 的源码，仅显示节点摘要或跳转到联邦视图

---

### Requirement: 视图模式扩展

Dashboard SHALL 在现有 `structural` / `domain` / `knowledge` 视图之外，新增 `federation` 视图模式。

#### Scenario: 视图切换

- **WHEN** 工作区模式下存在多个已分析项目
- **THEN** 用户可在联邦视图与单社区结构视图之间切换
