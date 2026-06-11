import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(
  __dirname,
  '../../../understand-anything-plugin/skills/understand/resolve-cross-community-links.mjs',
);

/**
 * 双项目联邦测试工作区（任务 7.3）：
 *   workspace/
 *   ├── .understand-workspace.json
 *   ├── refund-service/   ← 调用方（fetch 订单服务）
 *   └── order-service/    ← 被调用方（暴露 GET /orders/{id}，contextPath=/order-api）
 */
let ws;

const ORDER_README = `---
understand-community:
  serviceId: order-service
  displayName: 订单服务
  domains:
    - order.internal.com
  contextPaths:
    - /order-api
---
# Order Service
`;

const REFUND_README = `---
understand-community:
  serviceId: refund-service
  displayName: 退费服务
  domains:
    - refund.internal.com
---
# Refund Service
`;

function graphOf(projectName, nodes) {
  return {
    version: '1.1.0',
    project: {
      name: projectName,
      languages: ['typescript'],
      frameworks: [],
      description: '',
      analyzedAt: '2026-06-11T00:00:00.000Z',
      gitCommitHash: 'fixture',
    },
    nodes,
    edges: [],
    layers: [],
    tour: [],
  };
}

function writeTree(root, files) {
  for (const [relPath, contents] of Object.entries(files)) {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2), 'utf-8');
  }
}

/** 创建退费服务：已分析（有图谱），源码中调用订单服务。 */
function setupRefundService() {
  const root = join(ws, 'refund-service');
  writeTree(root, {
    'README.md': REFUND_README,
    'src/refund.ts': [
      'export async function queryRefund(id: string) {',
      '  const order = await fetch("https://order.internal.com/order-api/orders/123");',
      '  return order.json();',
      '}',
    ].join('\n'),
    '.understand-anything/knowledge-graph.json': graphOf('refund-service', [
      {
        id: 'endpoint:src/refund.ts:queryRefund',
        type: 'endpoint',
        name: 'GET /refund/{id}',
        filePath: 'src/refund.ts',
        summary: '查询退费',
        tags: ['api'],
        complexity: 'moderate',
      },
    ]),
  });
  return root;
}

/** 模拟订单服务完成 /understand：写入图谱（manifest 由脚本产出）。 */
function analyzeOrderService(readme = ORDER_README) {
  const root = join(ws, 'order-service');
  writeTree(root, {
    'README.md': readme,
    'src/OrderController.java': 'class OrderController {}',
    '.understand-anything/knowledge-graph.json': graphOf('order-service', [
      {
        id: 'endpoint:src/OrderController.java:getOrder',
        type: 'endpoint',
        name: 'GET /orders/{id}',
        filePath: 'src/OrderController.java',
        summary: '查询订单详情',
        tags: ['api'],
        complexity: 'simple',
      },
    ]),
  });
  return root;
}

function runScript(projectRoot) {
  const res = spawnSync('node', [SCRIPT, projectRoot], {
    encoding: 'utf-8',
    env: { ...process.env, UNDERSTAND_WORKSPACE_ROOT: ws },
  });
  expect(res.status, `script failed:\n${res.stderr}`).toBe(0);
  return JSON.parse(res.stdout);
}

function readJson(...segments) {
  return JSON.parse(readFileSync(join(...segments), 'utf-8'));
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'ua-federation-'));
  writeFileSync(
    join(ws, '.understand-workspace.json'),
    JSON.stringify({ version: '1', projects: ['refund-service', 'order-service'] }),
  );
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('resolve-cross-community-links.mjs（端到端）', () => {
  it('验收场景 1：先分析调用方 → placeholder → 分析被调用方 → 自动回填', () => {
    const refundRoot = setupRefundService();
    mkdirSync(join(ws, 'order-service'), { recursive: true }); // 目标存在但未分析

    // 第一步：分析 refund-service → 占位
    const report1 = runScript(refundRoot);
    expect(report1.serviceId).toBe('refund-service');
    expect(report1.workspaceMode).toBe(true);
    expect(report1.outboundSignals).toBeGreaterThanOrEqual(1);
    expect(report1.edges.pending).toBeGreaterThanOrEqual(1);

    const refundGraph1 = readJson(refundRoot, '.understand-anything', 'knowledge-graph.json');
    const placeholder = refundGraph1.nodes.find((n) => n.type === 'community');
    expect(placeholder).toBeDefined();
    expect(placeholder.communityMeta.status).toBe('pending');

    // outbound-links 持久化，含 matchHints
    const links1 = readJson(refundRoot, '.understand-anything', 'outbound-links.json');
    expect(links1.links[0].matchHints.domain).toBe('order.internal.com');
    expect(links1.links[0].matchHints.fullPath).toBe('/order-api/orders/{param}');

    // manifest 始终产出（即使没有出站匹配成功）
    expect(existsSync(join(refundRoot, '.understand-anything', 'community-manifest.json'))).toBe(true);

    // 第二步：order-service 完成分析 → 反向回填
    const orderRoot = analyzeOrderService();
    const report2 = runScript(orderRoot);
    expect(report2.serviceId).toBe('order-service');
    expect(report2.manifestRoutes).toBe(1);
    expect(report2.backfilledSiblings).toEqual([
      { project: 'refund-service', resolved: 1, stale: 0 },
    ]);
    expect(report2.modifiedSiblingPaths).toHaveLength(1);

    // refund 的图谱无需重跑 LLM 即升级为 resolved + 全局限定 remoteRef
    const refundGraph2 = readJson(refundRoot, '.understand-anything', 'knowledge-graph.json');
    const portal = refundGraph2.nodes.find((n) => n.type === 'community');
    expect(portal.id).toBe('community:order-service');
    expect(portal.communityMeta.status).toBe('resolved');
    const edge = refundGraph2.edges.find((e) => e.type === 'calls_community');
    expect(edge.communityMeta.status).toBe('resolved');
    expect(edge.communityMeta.remoteRef).toEqual({
      serviceId: 'order-service',
      graphKind: 'structural',
      nodeId: 'endpoint:src/OrderController.java:getOrder',
    });
  });

  it('验收场景 2：被调用方先分析时直接 resolved（含 contextPath 合成 fullPath）', () => {
    const orderRoot = analyzeOrderService();
    runScript(orderRoot);

    // manifest routeCatalog: contextPath + controllerPath
    const manifest = readJson(orderRoot, '.understand-anything', 'community-manifest.json');
    expect(manifest.routeCatalog[0].fullPath).toBe('/order-api/orders/{param}');
    expect(manifest.routeCatalog[0].contextPath).toBe('/order-api');

    const refundRoot = setupRefundService();
    const report = runScript(refundRoot);
    expect(report.edges.resolved).toBe(1);

    const refundGraph = readJson(refundRoot, '.understand-anything', 'knowledge-graph.json');
    const edge = refundGraph.edges.find((e) => e.type === 'calls_community');
    expect(edge.communityMeta.status).toBe('resolved');
    expect(edge.communityMeta.remoteRef.serviceId).toBe('order-service');
  });

  it('验收场景 3：多候选匹配失败标 ambiguous，不自动连线', () => {
    // 两个服务共享域名与 contextPath，暴露相同路由 → 无法消歧
    writeFileSync(
      join(ws, '.understand-workspace.json'),
      JSON.stringify({ version: '1', projects: ['refund-service', 'order-a', 'order-b'] }),
    );
    for (const name of ['order-a', 'order-b']) {
      const root = join(ws, name);
      writeTree(root, {
        'README.md': ORDER_README.replace('order-service', name),
        '.understand-anything/knowledge-graph.json': graphOf(name, [
          {
            id: `endpoint:src/OrderController.java:getOrder`,
            type: 'endpoint',
            name: 'GET /orders/{id}',
            filePath: 'src/OrderController.java',
            summary: '查询订单',
            tags: ['api'],
            complexity: 'simple',
          },
        ]),
      });
      runScript(root);
    }

    const refundRoot = setupRefundService();
    const report = runScript(refundRoot);
    expect(report.edges.ambiguous).toBe(1);
    expect(report.ambiguousDetails[0].candidates).toEqual(
      expect.arrayContaining(['order-a', 'order-b']),
    );

    // 不自动连线：边存在但无 remoteRef
    const refundGraph = readJson(refundRoot, '.understand-anything', 'knowledge-graph.json');
    const edge = refundGraph.edges.find((e) => e.type === 'calls_community');
    expect(edge.communityMeta.status).toBe('ambiguous');
    expect(edge.communityMeta.remoteRef).toBeUndefined();
  });

  it('验收场景 4：被调用方 contextPath 变更 → 引用方边标 stale', () => {
    // 初始：双方 resolved
    const orderRoot = analyzeOrderService();
    runScript(orderRoot);
    const refundRoot = setupRefundService();
    runScript(refundRoot);

    // order-service 将 contextPath 从 /order-api 改为 /api/order 并重新分析
    analyzeOrderService(ORDER_README.replace('/order-api', '/api/order'));
    const report = runScript(orderRoot);
    expect(report.backfilledSiblings).toEqual([
      { project: 'refund-service', resolved: 0, stale: 1 },
    ]);

    const links = readJson(refundRoot, '.understand-anything', 'outbound-links.json');
    expect(links.links[0].status).toBe('stale');
    const refundGraph = readJson(refundRoot, '.understand-anything', 'knowledge-graph.json');
    const edge = refundGraph.edges.find((e) => e.type === 'calls_community');
    expect(edge.communityMeta.status).toBe('stale');
  });

  it('离线模式：无工作区时仍产出 manifest，跳过跨社区解析', () => {
    const root = mkdtempSync(join(tmpdir(), 'ua-offline-'));
    try {
      writeTree(root, {
        'README.md': REFUND_README,
        '.understand-anything/knowledge-graph.json': graphOf('refund-service', [
          {
            id: 'file:src/index.ts',
            type: 'file',
            name: 'index.ts',
            filePath: 'src/index.ts',
            summary: '入口',
            tags: ['entry'],
            complexity: 'simple',
          },
        ]),
      });
      const res = spawnSync('node', [SCRIPT, root], {
        encoding: 'utf-8',
        env: { ...process.env, UNDERSTAND_WORKSPACE_ROOT: '' },
      });
      expect(res.status, res.stderr).toBe(0);
      const report = JSON.parse(res.stdout);
      expect(report.workspaceMode).toBe(false);
      expect(report.backfilledSiblings).toEqual([]);
      expect(existsSync(join(root, '.understand-anything', 'community-manifest.json'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('幂等性：重复执行不产生重复的 community 节点或边', () => {
    const orderRoot = analyzeOrderService();
    runScript(orderRoot);
    const refundRoot = setupRefundService();
    runScript(refundRoot);
    runScript(refundRoot); // 第二次执行

    const refundGraph = readJson(refundRoot, '.understand-anything', 'knowledge-graph.json');
    expect(refundGraph.nodes.filter((n) => n.type === 'community')).toHaveLength(1);
    expect(refundGraph.edges.filter((e) => e.type === 'calls_community')).toHaveLength(1);
  });
});
