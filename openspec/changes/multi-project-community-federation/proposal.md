## Why

Understand-Anything 目前仅支持对**单个项目**进行分析和生成知识图谱，无法表达微服务/多仓库之间的跨项目依赖关系。在典型企业场景中，各项目独立部署、通过 HTTP/RPC/MQ 等方式相互调用，开发者需要在多个孤立图谱之间手动建立心智模型，认知成本高。

本变更引入**服务社区联邦（Service Community Federation）**能力：每个项目仍独立分析，但通过分布式 README 索引与跨社区边，将「退费服务调用订单服务」等关系显式建模，并支持联邦鸟瞰图与单社区门户视图，且对未分析项目使用占位节点、待目标项目分析后自动回填。

## What Changes

- 引入**工作区（Workspace）**模型：父目录下包含多个子项目，分析时扫描兄弟项目的 `community-manifest.json` 构建临时索引
- 扩展 `/understand`：解析 README `understand-community` frontmatter、发现出站跨服务依赖、生成 `community-manifest.json` 与 `outbound-links.json`
- 新增图谱 schema 扩展：`community` 节点类型、跨社区边类型（`calls_community` 等）、`CommunityMeta` 元数据
- 实现 **domain + fullPath（含 contextPath）** 匹配策略，支持共享域名消歧；匹配失败时标 `ambiguous`（不自动猜测）
- 实现 **placeholder + 双向 backfill**：目标社区未分析时占位，分析结束时更新工作区内相关项目的跨社区引用
- 扩展 Dashboard：新增联邦社区视图（仅社区间关系）与单社区门户展示（`本节点 → 外社区：外节点`）
- 节点级关联主存 `endpoint`（结构图），展示名优先 `flow/step`（若存在 domain-graph）
- 默认 **一仓库一社区**；多栈 contextPath 自动发现（Spring/Express 等）+ README 兜底
- 跨项目节点引用使用 **serviceId 全局限定**（`serviceId/graphKind/nodeId`），避免 ID 碰撞

### 非目标（第一期不做）

- 一次性多项目联合分析
- 中心化域名注册表
- 匹配失败时自动选择候选（策略 B）
- MQ/gRPC/Dubbo/共享 DB 出站发现（第二期）
- 一仓多社区拆分（第二期）
- `/understand-chat`、`/understand-diff` 等技能的跨社区上下文（第一期仅 `/understand` + Dashboard）
- ambiguous 边的人工确认 UI（第一期仅报告列出）

## Capabilities

### New Capabilities

- `workspace-community-index`：工作区发现、README 社区身份解析、community-manifest 产出与分布式索引读取
- `cross-community-linking`：出站依赖发现、fullPath 归一化（含 contextPath）、跨社区边匹配、placeholder/backfill、stale 边处理
- `federation-dashboard`：联邦社区鸟瞰图、单社区跨项目门户展示、Dashboard 工作区启动模型

### Modified Capabilities

- （无）— 仓库中尚无 `openspec/specs/` 基线规格，本次均为新增能力

## Impact

- **Core 包**（`packages/core`）：`types.ts`、`schema.ts` 扩展节点/边类型与 `CommunityMeta`；新增 manifest/backfill 持久化与路径匹配工具
- **Skill**（`skills/understand`）：Phase 0+ 社区身份、出站发现、分析结束 backfill 步骤；`project-scanner` README frontmatter 解析
- **Agents**：`file-analyzer` 出站 HTTP 信号提取；`graph-reviewer` 跨社区边校验规则
- **Dashboard**（`packages/dashboard`）：新联邦视图、`vite.config.ts` 工作区 manifest 读取与安全策略扩展
- **持久化产物**（各项目 `.understand-anything/`）：新增 `community-manifest.json`、`outbound-links.json`；建议纳入 Git
- **工作区根**（可选）：`.understand-workspace.json`、`.understand-federation/federation-graph.json`（运行时聚合）
- **向后兼容**：旧图谱无 community 字段时静默兼容；schema version 从 `1.0.0` 扩展
