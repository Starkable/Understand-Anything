## ADDED Requirements

### Requirement: 工作区根目录发现

系统 SHALL 通过以下方式之一确定工作区根目录（按优先级）：

1. 环境变量 `UNDERSTAND_WORKSPACE_ROOT`
2. 从当前项目根向上查找 `.understand-workspace.json`
3. 若均未找到，系统 SHALL 进入离线模式（仅单项目分析，不解析跨社区依赖）

#### Scenario: 通过环境变量指定工作区

- **WHEN** 用户设置 `UNDERSTAND_WORKSPACE_ROOT=/workspace` 并对 `/workspace/refund-service` 执行 `/understand`
- **THEN** 系统以 `/workspace` 为工作区根扫描兄弟项目

#### Scenario: 通过配置文件发现工作区

- **WHEN** `/workspace/.understand-workspace.json` 存在且当前项目位于 `/workspace/refund-service`
- **THEN** 系统识别 `/workspace` 为工作区根

#### Scenario: 无工作区配置时离线运行

- **WHEN** 未设置环境变量且不存在 `.understand-workspace.json`
- **THEN** 系统完成单项目图谱分析，跳过跨社区依赖解析，仍产出 `community-manifest.json`

---

### Requirement: README 社区身份解析

系统 SHALL 解析项目 README 顶部的 `understand-community` YAML frontmatter，提取 `serviceId`、`displayName`、`domains`、`aliases`、`contextPaths`。

#### Scenario: 完整 frontmatter 解析

- **WHEN** README 包含有效的 `understand-community` frontmatter
- **THEN** 系统使用其中的 `serviceId` 和 `domains` 作为社区身份

#### Scenario: serviceId 缺失时的 fallback

- **WHEN** README 无 `understand-community` 或缺少 `serviceId`
- **THEN** 系统依次尝试 `package.json` name、仓库目录名作为 `serviceId`，并写入 `.understand-anything/community-identity.json` 提示用户补充 README

#### Scenario: 不自动修改 README

- **WHEN** 系统推断出 serviceId 或生成随机 ID
- **THEN** 系统 SHALL NOT 自动修改 README 文件，仅写入 sidecar 文件并报告

---

### Requirement: community-manifest 产出

每次 `/understand` 分析完成后，系统 SHALL 在 `.understand-anything/community-manifest.json` 写入社区清单，至少包含：

- `serviceId`、`displayName`、`projectPath`、`analyzedAt`
- `identity.domains`、`identity.aliases`、`identity.contextPaths`
- `routeCatalog`（含 `method`、`controllerPath`、`fullPath`、`contextPath`、`nodeId`）
- `graphRefs.structural` 和 `graphRefs.domain`（若存在）

#### Scenario: 分析完成后生成 manifest

- **WHEN** `/understand` 对 `order-service` 成功完成
- **THEN** `.understand-anything/community-manifest.json` 存在且包含该项目的 `routeCatalog`

#### Scenario: routeCatalog 包含 fullPath

- **WHEN** 项目配置 `server.servlet.context-path=/order-api` 且控制器映射 `/orders/{id}`
- **THEN** `routeCatalog` 中对应条目的 `fullPath` 为 `/order-api/orders/{id}`

---

### Requirement: 分布式 manifest 索引读取

分析项目时，系统 SHALL 读取工作区内其他项目（排除当前项目）的 `community-manifest.json`，在内存中构建临时 lookup 表，分析结束后释放。系统 SHALL NOT 要求中心化注册表文件。

#### Scenario: 扫描兄弟项目 manifest

- **WHEN** 工作区包含 `refund-service` 和 `order-service`，且仅 `order-service` 已分析
- **THEN** 分析 `refund-service` 时能读取 `order-service` 的 manifest 并忽略无 manifest 的项目

#### Scenario: 新增项目 clone 后自动发现

- **WHEN** 用户将 `payment-service` clone 到工作区并首次分析
- **THEN** 后续分析其他项目时能读取 `payment-service` 的 manifest，无需更新中心化配置

---

### Requirement: 默认一仓库一社区

系统 SHALL 默认将单个 Git 仓库视为一个服务社区。单仓库多模块合并继续使用现有 `merge-subdomain-graphs.py` 处理仓内子图，产出单一 `community-manifest.json` 于仓库根 `.understand-anything/`。

#### Scenario: 单仓库多模块

- **WHEN** 一个仓库包含 `packages/api` 和 `packages/worker` 两个模块
- **THEN** 系统产出一份 `community-manifest.json`，`serviceId` 取自仓库根 README
