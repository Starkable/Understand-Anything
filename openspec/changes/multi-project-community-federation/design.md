## Context

### 当前状态

Understand-Anything 以单项目为边界运行 `/understand`，产物存储于 `<project>/.understand-anything/knowledge-graph.json`。Dashboard 通过 `GRAPH_DIR` 或 `cwd` 加载**单个**项目图谱。已有能力：

- **结构图**（`knowledge-graph.json`）：文件/函数/endpoint 等
- **业务域图**（`domain-graph.json`，可选）：`domain` / `flow` / `step` + 项目内 `cross_domain`
- **仓内多子图合并**（`merge-subdomain-graphs.py`）：单仓库内 `frontend-knowledge-graph.json` 等合并

上述 `domain` 节点表示**项目内业务域**，与本次「服务社区（跨项目）」是不同概念。代码中 Louvain 算法的 "community" 指文件聚类批次，亦需区分。

### 用户场景

```
/workspace/                    ← 工作区根（用户手动维护）
├── refund-service/            ← 各项目独立 clone
├── order-service/
└── payment-service/
```

用户对新仓库手动 clone 到工作区，再对单个项目手动执行 `/understand` 构建图谱。分析时发现跨服务调用，需关联到兄弟项目的具体节点。

### 约束

- 不做一次性多项目联合分析
- 社区身份由各项目 README 分布式维护，无中心化域名注册表
- 共享域名通过 `domain + fullPath（含 contextPath）` 消歧
- 匹配失败标 `ambiguous`，不自动猜测
- 分析结束时双向 backfill，可修改工作区内兄弟项目的跨社区相关文件
- 默认一仓库一社区

## Goals / Non-Goals

**Goals:**

1. 单项目 `/understand` 扩展后自动产出社区 manifest 与跨社区边
2. 工作区内按需读取兄弟项目 manifest 做分布式索引
3. 未分析目标社区使用 placeholder，目标分析后自动回填到具体 endpoint
4. Dashboard 提供联邦社区鸟瞰图与单社区门户视图
5. 跨项目节点引用全局唯一（`serviceId` 限定）
6. 多技术栈 contextPath 自动发现 + README 兜底

**Non-Goals（第一期）:**

- MQ / gRPC / Dubbo / 共享 DB 出站发现
- 一仓多社区拆分
- ambiguous 人工确认 UI
- `/understand-chat` 等技能的跨社区上下文
- 网关 `gatewayMappings` 自动解析
- 一次性多项目分析
- README 自动写回（第一期用 sidecar 文件 + 提示）

## Decisions

### D1：工作区发现 — 配置文件 + 环境变量

**决策**：工作区根通过向上查找 `.understand-workspace.json` 或环境变量 `UNDERSTAND_WORKSPACE_ROOT` 确定。

```json
// <workspaceRoot>/.understand-workspace.json
{
  "version": "1",
  "projects": ["refund-service", "order-service", "payment-service"]
}
```

`projects` 可为相对路径列表；若省略则扫描工作区根下所有含 `.understand-anything/` 的子目录。

**备选**：纯启发式（父目录 ≥2 个子项目即视为工作区）— 误判风险高，不采用。

**离线模式**：未配置工作区时，跳过跨社区能力，仅产出单项目图谱与 manifest（供日后加入工作区后被别人引用）。

---

### D2：社区身份 — README frontmatter + sidecar 兜底

**决策**：优先解析 README 顶部 `understand-community` YAML frontmatter：

```yaml
---
understand-community:
  serviceId: order-service
  displayName: 订单信息
  domains:
    - order.internal.com
    - api.company.com
  aliases:
    - order-svc
  contextPaths:
    - /order-api
---
```

| 字段缺失时 | fallback |
|------------|----------|
| `serviceId` | `package.json` name → 仓库目录名 → 写入 `community-identity.json` 并提示用户补充 README |
| `displayName` | `serviceId` |
| `domains` | 跳过跨社区匹配（仅产出 manifest 供他人引用） |

**不自动修改 README**（避免未预期的 git dirty）；生成 `.understand-anything/community-identity.json` 记录分析器推断的身份。

---

### D3：分布式索引 — 按需读取兄弟 manifest

**决策**：分析项目 A 时，读取工作区内其他项目的 `.understand-anything/community-manifest.json`，在内存构建 lookup 表，分析结束释放。不维护中心化索引文件。

lookup 表结构：

```
domain → [ { serviceId, projectPath, contextPaths, routeCatalog } ]
alias  → serviceId
serviceId → manifest
```

**备选**：工作区根维护 `domain-index.json` 增量更新 — 增加写入协调复杂度，第一期不采用；联邦图运行时聚合即可。

---

### D4：Schema 扩展 — 新增 `community` 节点与跨社区边

**决策**：扩展 `NodeType` 和 `EdgeType`（图谱 version 升至 `1.1.0`）：

```typescript
// 新节点类型
type NodeType = ... | "community";

// 新边类型（第一期仅 HTTP）
type EdgeType = ... | "calls_community";

interface CommunityMeta {
  status: "pending" | "resolved" | "ambiguous" | "stale";
  serviceId?: string;
  domains?: string[];
  projectRef?: string;           // 兄弟项目相对路径
  remoteRef?: RemoteNodeRef;     // 全局限定引用
  remoteDisplayName?: string;    // 展示用（优先 flow/step name）
  matchHints?: MatchHints;
  confidence?: number;
}

interface RemoteNodeRef {
  serviceId: string;
  graphKind: "structural" | "domain";
  nodeId: string;
}

interface MatchHints {
  domain?: string;
  method?: string;
  fullPath?: string;
  contextPathHint?: string;
}
```

**命名区分**：

| 术语 | 含义 |
|------|------|
| `domain` 节点 | 项目内业务域 |
| `community` 节点 | 跨项目服务社区门户 |
| Louvain community | 文件分析批次（内部实现） |

---

### D5：路径匹配 — fullPath = contextPath + controllerPath

**决策**：入站侧从路由定义 + 配置提取 `fullPath` 写入 `routeCatalog`；出站侧合成调用方 `fullPath`；匹配键为 `domain + method + fullPath（归一化）`。

归一化规则：

- 合并斜杠、去尾斜杠
- 路径参数统一为 `{param}`（`{id}`、`:id`、`<id>` → `{param}`）
- 忽略 query string（第一期）

contextPath 自动发现（优先级）：

| P0 | Spring Boot `server.servlet.context-path` |
| P0 | Express `app.use('/prefix', router)` |
| P1 | Gin `Group("/api")`、FastAPI `APIRouter(prefix=)`、NestJS `setGlobalPrefix()` |
| 兜底 | README `contextPaths` |

共享域名消歧：

```
1. domain 命中多个 manifest → 候选集
2. contextPath 前缀过滤
3. routeCatalog fullPath 模式匹配
4. method 校验
5. 唯一命中 → resolved；否则 → ambiguous
```

---

### D6：节点关联 — 主存 endpoint，展示优先 flow/step

**决策**：

- `remoteRef` 主指向结构图 `endpoint` 节点（每次 `/understand` 必产出，确定性高）
- 若目标项目存在 `domain-graph.json`，额外解析 `remoteDisplayName`（匹配同名 flow/step）
- Dashboard 门户展示：`[本节点] → [订单社区：查询订单详情]`

---

### D7：placeholder + 双向 backfill

**决策**：每次 `/understand` 结束时执行 `resolve-cross-community-links` 步骤：

**正向**（当前项目出站）：
- 读取工作区 manifest 索引
- 解析出站依赖 → 建立 `calls_community` 边
- 目标未分析 → `community` 节点 `status=pending`

**反向**（兄弟项目引用当前项目）：
- 扫描工作区内所有 `outbound-links.json`
- 凡 `matchHints` 或 `serviceId` 指向当前项目 → 用新 `routeCatalog` 回填
- 更新兄弟项目的跨社区边与 `community` 节点状态

**产物**：

| 文件 | 位置 | 进 Git |
|------|------|--------|
| `community-manifest.json` | 各项目 `.understand-anything/` | 是 |
| `outbound-links.json` | 各项目 `.understand-anything/` | 是 |
| `federation-graph.json` | 工作区 `.understand-federation/`（可选，可运行时生成） | 可选 |

backfill 修改兄弟项目文件后**不自动 commit**，在分析报告中列出变更清单。

**并发**：不支持同一工作区内并行运行 `/understand`（文档声明）；backfill 步骤使用简单文件锁（`*.lock`）防御。

---

### D8：stale 边生命周期

**决策**：当项目 B 重新分析且 `routeCatalog` 变化时：

1. 更新 B 的 manifest
2. 反向扫描引用 B 的项目
3. 已有 `resolved` 边重新验证 matchHints
4. 不再匹配 → 标 `status=stale`；可重新匹配 → 更新 `remoteRef`

增量更新与 auto-update hook 在 Phase 6 后同样执行 `resolve-cross-community-links`（轻量，无 LLM）。

---

### D9：Dashboard 启动模型

**决策**：两种启动模式：

| 模式 | 启动方式 | 视图 |
|------|----------|------|
| 单社区 | `GRAPH_DIR=<project>` 或从项目目录 `pnpm dev:dashboard` | 结构图/业务域图 + 跨社区门户边 |
| 联邦 | `UNDERSTAND_WORKSPACE_ROOT=<workspace>` 从工作区根启动 | 仅社区节点 + 聚合边 |

`vite.config.ts` 扩展：

- 工作区模式下提供 `/federation-graph.json`（运行时聚合各 manifest）
- 单社区模式下提供 `/community-manifest/<serviceId>.json` 只读代理（读取兄弟项目 manifest 获取展示名，路径限制在工作区内）
- 保持现有单项目源码预览安全策略不变

---

### D10：环境维度

**决策**：第一期将所有环境域名（dev/staging/prod）合并进 manifest `domains`，匹配时任一命中即可。不在第一期引入 `--env` 参数。

## Risks / Trade-offs

| 风险 | 缓解 |
|------|------|
| 跨项目节点 ID 碰撞 | 强制 `RemoteNodeRef` 含 `serviceId` 三元组 |
| backfill 产生兄弟项目未提交变更 | 分析报告明确列出；不自动 commit |
| 出站依赖误报（注释 URL、占位符配置） | confidence 阈值 + 仅采纳静态可解析信号；低置信标 ambiguous |
| 出站依赖漏报（`${ORDER_URL}` 变量） | 第一期接受；README aliases 补充；第二期配置解析 |
| 共享域名消歧失败 | 策略 A：标 ambiguous，不自动连线 |
| Dashboard 安全：跨目录读 manifest | 路径限制在工作区根内；只读 manifest，不提供兄弟项目源码 |
| 并行分析文件竞争 | 文档声明不支持；backfill 文件锁 |
| 目标项目 route 变更导致 stale 边 | 重新分析时反向 stale 扫描 |
| 与现有 `domain`/`service` 节点混淆 | agent prompt 明确术语；schema 文档 |
| auto-update 不触发兄弟项目重分析 | 仅更新 manifest + 反向 stale 扫描，不重跑兄弟项目 LLM |

## Migration Plan

1. **Schema 扩展**：`validateGraph` 接受新类型；旧图谱无 community 字段正常加载
2. **Opt-in 启用**：README 无 `understand-community` 时行为与现有一致（仅多写 manifest 基础信息）
3. **工作区配置**：用户在工作区根添加 `.understand-workspace.json`
4. **存量项目**：逐个跑 `/understand` 生成 manifest；先分析被依赖方（如 order）再分析调用方（如 refund）可最快消除 placeholder
5. **回滚**：删除 `.understand-anything/community-manifest.json` 与跨社区边即可；不影响结构图主体

## Open Questions

1. **联邦 Dashboard 是否第一期必须交付**，还是先交付分析管线 + CLI 报告，Dashboard 视图第二期？（建议第一期至少交付基础联邦 JSON 端点 + 单社区门户边展示）
2. **contextPath 自动发现**各栈实现深度：第一期 P0 栈的测试覆盖范围
3. **`federation-graph.json` 是否持久化**到工作区根，或纯运行时聚合（建议纯运行时，减少协调）
