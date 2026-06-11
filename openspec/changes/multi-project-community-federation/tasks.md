## 1. Schema 与类型扩展

- [x] 1.1 在 `packages/core/src/types.ts` 新增 `community` 节点类型、`calls_community` 边类型、`CommunityMeta`、`RemoteNodeRef`、`MatchHints` 接口
- [x] 1.2 在 `packages/core/src/schema.ts` 扩展 Zod schema 与别名映射，图谱 version 升至 `1.1.0`
- [x] 1.3 编写 schema 单元测试：community 节点、calls_community 边、旧图谱向后兼容
- [x] 1.4 更新 `graph-reviewer` agent 文档：跨社区边校验规则与术语区分（community vs domain vs Louvain）

## 2. 工作区与社区身份（workspace-community-index）

- [x] 2.1 在 `packages/core` 新增 `workspace/` 模块：`resolveWorkspaceRoot()`、`loadWorkspaceConfig()`、`discoverProjects()`
- [x] 2.2 实现 README `understand-community` frontmatter 解析器，含 serviceId fallback 与 `community-identity.json` sidecar 写入
- [x] 2.3 实现 `community-manifest.json` 生成器：从图谱 endpoint 节点 + contextPath 构建 `routeCatalog`
- [x] 2.4 实现分布式 manifest 读取：`loadSiblingManifests(workspaceRoot, excludeProject)` 内存 lookup 表
- [x] 2.5 编写工作区发现与 manifest 读写单元测试
- [x] 2.6 在 `skills/understand/SKILL.md` Phase 0 增加社区身份解析与工作区发现步骤

## 3. contextPath 与路径归一化

- [x] 3.1 实现路径归一化工具：斜杠合并、尾斜杠、参数统一为 `{param}`、忽略 query
- [x] 3.2 实现 Spring Boot `server.servlet.context-path` 配置提取
- [x] 3.3 实现 Express `app.use(prefix)` 路由前缀提取
- [x] 3.4 实现 Gin Group / FastAPI APIRouter prefix / NestJS globalPrefix 提取（P1）
- [x] 3.5 实现 `fullPath = contextPath + controllerPath` 合成逻辑
- [x] 3.6 编写 contextPath 与路径匹配单元测试（含共享域名消歧场景）

## 4. 跨社区链接（cross-community-linking）

- [x] 4.1 实现出站 HTTP 依赖发现脚本：提取 domain、method、fullPath（URL / baseUrl+相对路径）
- [x] 4.2 实现跨社区匹配引擎：`domain + method + fullPath` 对 routeCatalog 匹配，含 contextPath 前缀过滤
- [x] 4.3 实现 `community` 占位节点与 `calls_community` 边写入知识图谱
- [x] 4.4 实现 `outbound-links.json` 读写
- [x] 4.5 实现双向 backfill：`resolve-cross-community-links.mjs`（正向出站 + 反向兄弟项目回填）
- [x] 4.6 实现 stale 边扫描：routeCatalog 变更后标记兄弟项目中的失效边
- [x] 4.7 实现 `remoteDisplayName` 解析：目标项目有 domain-graph 时匹配 flow/step 名称
- [x] 4.8 在 `skills/understand/SKILL.md` Phase 6 后增加 `resolve-cross-community-links` 步骤
- [x] 4.9 更新 `hooks/auto-update-prompt.md`：增量更新后执行轻量 backfill
- [x] 4.10 编写跨社区链接集成测试：占位、回填、ambiguous、stale 四个验收场景

## 5. Skill 与 Agent 集成

- [x] 5.1 更新 `project-scanner`：传递 README frontmatter 解析结果到 scan-result
- [x] 5.2 更新 `file-analyzer` prompt：出站 HTTP 信号标注指引（供 LLM 补充语义边）
- [x] 5.3 更新 `skills/understand/SKILL.md` 参考文档：community 节点/边类型、README 约定、工作区配置说明
- [x] 5.4 新增 `skills/understand/frameworks/` 跨服务调用识别补充指引（Feign/RestTemplate/fetch 等）

## 6. Dashboard 联邦视图（federation-dashboard）

- [x] 6.1 扩展 `vite.config.ts`：工作区模式、`/federation-graph.json` 端点、兄弟 manifest 只读代理
- [x] 6.2 实现联邦图运行时聚合：从各 manifest + outbound-links 生成社区节点与聚合边
- [x] 6.3 在 `store.ts` 新增 `federation` 视图模式与联邦图状态
- [x] 6.4 实现 `FederationGraphView` 组件：社区节点 + 聚合边 + pending/ambiguous 样式
- [x] 6.5 扩展单社区视图：跨社区门户边展示「外社区：外节点」格式
- [x] 6.6 添加 i18n 文案：`calls_community` 边类型、门户展示、ambiguous/stale 状态
- [x] 6.7 编写 Dashboard 联邦视图相关测试

## 7. 文档与验收

- [x] 7.1 在 `docs/` 下新增多项目社区联邦使用指南（README frontmatter 约定、工作区配置、分析顺序建议）
- [x] 7.2 更新 `agents/knowledge-graph-guide.md`：community-manifest、outbound-links、federation 说明
- [x] 7.3 创建双项目测试 fixture 工作区（refund-service + order-service）用于端到端验收
- [x] 7.4 验收场景 1：先分析调用方 → placeholder → 分析被调用方 → 自动回填
- [x] 7.5 验收场景 2：共享域名 + 不同 contextPath 正确消歧
- [x] 7.6 验收场景 3：匹配失败标 ambiguous，不自动连线
- [x] 7.7 验收场景 4：被调用方 contextPath 变更 → 引用方边标 stale
