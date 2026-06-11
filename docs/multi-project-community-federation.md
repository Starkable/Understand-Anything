# 多项目社区联邦使用指南

本指南介绍如何在一个包含多个项目的工作区中，使用 Understand-Anything 的「社区联邦」能力：每个项目是一个独立的知识图谱（服务社区），跨项目的 HTTP 调用会被自动发现并关联为社区间的边。

## 核心概念

| 概念 | 说明 |
|---|---|
| 工作区（workspace） | 包含多个可分析项目的父目录，是跨项目关联的作用域 |
| 服务社区（community） | 一个项目对应一个社区，以 `serviceId` 唯一标识 |
| `community` 节点 | 知识图谱中代表「外部社区」的门户节点，ID 为 `community:<serviceId>` |
| `calls_community` 边 | 本项目节点 → 外部社区节点的跨社区调用边 |
| 占位（pending） | 目标社区尚未被分析时创建的临时占位节点/边 |
| 回填（backfill） | 目标社区被分析后，自动更新引用方项目中的占位信息 |

## 1. 工作区配置

跨项目关联只在「工作区模式」下生效。有两种声明方式（任选其一）：

### 方式 A：环境变量

```bash
export UNDERSTAND_WORKSPACE_ROOT=/path/to/workspace
```

### 方式 B：工作区配置文件（推荐）

在多个项目的公共父目录下创建 `.understand-workspace.json`：

```json
{
  "version": "1",
  "projects": ["refund-service", "order-service"]
}
```

- `projects` 可省略：省略时自动扫描工作区下所有含 `.understand-anything/` 目录的一级子目录。
- 分析与 Dashboard 启动时都会从当前项目向上查找该文件（最多 6 层）。

## 2. README 社区身份声明

每个项目在 `README.md` 顶部以 YAML frontmatter 声明自己的服务身份（分布式 README 索引）：

```markdown
---
understand-community:
  serviceId: order-service
  displayName: 订单服务
  domains:
    - order.internal.example.com
    - api.example.com        # 多项目可共享域名，依靠 contextPath 消歧
  aliases:
    - order-svc
---

# Order Service
...
```

字段说明：

- `serviceId`（必填语义，缺省时回退）：社区唯一标识。未声明时按 `package.json` 的 `name` → 目录名 顺序回退，并将推断结果写入 `.understand-anything/community-identity.json` sidecar。
- `domains`：该服务对外暴露的域名列表，一个项目可声明多个域名，多个项目也可共享同一域名（由 `contextPath` 消歧）。
- `aliases`：服务别名，辅助匹配。

## 3. 分析流程与产物

分析始终是**单项目触发**的（在某个项目内运行 `/understand`），跨项目关联由分析尾声的 `resolve-cross-community-links.mjs` 步骤完成：

1. 解析本项目社区身份与 `contextPath`（支持 Spring Boot / Express / Gin / FastAPI / NestJS 自动发现）。
2. 扫描本项目源码中的出站 HTTP 调用（字面 URL、baseUrl 拼接等），提取 `domain + method + fullPath`。
3. 与工作区内兄弟项目的 `community-manifest.json` 路由目录（routeCatalog）做匹配：
   - 匹配成功 → `resolved`，边携带 `remoteRef` 指向目标社区的具体 endpoint 节点；
   - 目标社区未分析 → `pending` 占位；
   - 多个候选无法区分 → `ambiguous`，不自动连线；
   - 目标路由已变更 → `stale`，提示需重新分析。
4. 将 `community` 节点与 `calls_community` 边写入本项目知识图谱。
5. **反向回填**：本项目分析完成后，扫描兄弟项目中指向本项目的占位/过期引用并更新其图谱与 `outbound-links.json`。

每个项目 `.understand-anything/` 下的联邦相关产物：

| 文件 | 内容 |
|---|---|
| `community-manifest.json` | 本项目社区身份 + 暴露的路由目录（`fullPath = contextPath + controllerPath`） |
| `outbound-links.json` | 本项目发现的出站跨社区调用及其匹配状态 |
| `community-identity.json` | 身份为推断（非 README 声明）时的 sidecar 记录 |

## 4. 分析顺序建议

分析顺序不影响最终结果（占位 + 回填机制保证收敛），但推荐：

1. **优先分析被依赖多的基础服务**（如订单、用户服务），使后续项目的出站调用能直接 `resolved`；
2. 再分析上层业务服务（如退费服务）；
3. 任意项目代码变更后重新分析，增量更新钩子会自动执行轻量回填。

## 5. Dashboard 联邦视图

在工作区模式下启动 Dashboard（`/understand-dashboard`）：

- 顶栏出现「联邦视图」切换按钮（仅当 `/federation-graph.json` 返回数据时显示）；
- 联邦视图只展示「社区 ↔ 社区」聚合关系：每个社区一张卡片（已分析/未分析样式区分），每对调用关系一条聚合边并标注调用点数量；
- 边样式按状态区分：`resolved` 实线动画、`pending` 灰色虚线、`ambiguous` 黄色点线、`stale` 红色虚线；
- 单社区视图中，点击 `community` 节点可在右侧面板查看外部社区详情（serviceId、域名、状态），`calls_community` 连接会展示「远端节点」名称（优先目标项目 domain-graph 的 flow/step 名）与匹配的 `method + fullPath`，不会展开外部社区的完整图谱。

数据端点（仅 dev server、受 token 保护、只读）：

- `/federation-graph.json` — 运行时聚合所有 manifest + outbound-links，不落盘持久化；
- `/community-manifest.json?serviceId=<id>` — 兄弟项目 manifest 只读代理。

## 6. 状态语义与排障

| 状态 | 含义 | 处理建议 |
|---|---|---|
| `pending` | 目标社区未分析 | 在目标项目运行 `/understand`，回填后自动变为 `resolved` |
| `resolved` | 已匹配到目标社区具体节点 | 无需处理 |
| `ambiguous` | 多候选无法消歧（如共享域名且 contextPath 不可区分） | 检查目标项目 `contextPath` 配置或 README `domains` 声明 |
| `stale` | 目标路由已变更（如 contextPath 调整） | 重新分析调用方项目以重新匹配 |

常见问题：

- **调用未被发现**：出站 URL 为模板变量主机（如 `https://${HOST}/...`）时无法确定目标域名，会被跳过；可在 README `domains` 中补充别名或改用可解析的常量。
- **共享域名误连**：确认各项目的 `contextPath` 已被正确发现（Spring 的 `server.servlet.context-path` 等），匹配引擎以 `fullPath` 前缀过滤候选。
- **非 HTTP 依赖（MQ/gRPC/共享 DB）**：当前版本以 HTTP 为主，其余协议在后续迭代中支持。
