import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { KnowledgeGraph, OutboundLinksFile } from "../types.js";
import {
  matchOutboundCall,
  applyCommunityLinks,
  stripCommunityArtifacts,
  toOutboundLinks,
  backfillSiblingProject,
  communityNodeId,
  type OutboundCallSignal,
} from "../workspace/linker.js";
import {
  buildCommunityManifest,
  saveCommunityManifest,
  loadSiblingManifests,
  saveOutboundLinks,
  loadOutboundLinks,
} from "../workspace/manifest.js";
import type { ResolvedCommunityIdentity } from "../workspace/identity.js";

let ws: string;

function makeGraph(projectName: string, nodes: KnowledgeGraph["nodes"]): KnowledgeGraph {
  return {
    version: "1.1.0",
    project: {
      name: projectName,
      languages: ["typescript"],
      frameworks: [],
      description: "",
      analyzedAt: "2026-06-11T00:00:00.000Z",
      gitCommitHash: "x",
    },
    nodes,
    edges: [],
    layers: [],
    tour: [],
  };
}

function identityOf(
  serviceId: string,
  domains: string[],
  contextPaths: string[] = [],
): ResolvedCommunityIdentity {
  return {
    serviceId,
    displayName: serviceId,
    identity: { domains, aliases: [], contextPaths },
    source: "readme",
    needsReadmeUpdate: false,
  };
}

/** 模拟 refund-service：包含一个调用订单服务的 endpoint。 */
function setupRefundService(): { root: string; graph: KnowledgeGraph; signal: OutboundCallSignal } {
  const root = join(ws, "refund-service");
  mkdirSync(join(root, ".understand-anything"), { recursive: true });
  const graph = makeGraph("refund-service", [
    {
      id: "endpoint:src/refund.ts:queryRefund",
      type: "endpoint",
      name: "GET /refund/{id}",
      summary: "查询退费",
      tags: ["api"],
      complexity: "moderate",
    },
  ]);
  const signal: OutboundCallSignal = {
    sourceNodeId: "endpoint:src/refund.ts:queryRefund",
    domain: "order.internal.com",
    method: "GET",
    path: "/order-api/orders/{param}",
    confidence: 0.85,
  };
  return { root, graph, signal };
}

/** 模拟 order-service：分析完成并产出 manifest。 */
function setupOrderService(contextPath = "/order-api"): string {
  const root = join(ws, "order-service");
  mkdirSync(join(root, ".understand-anything"), { recursive: true });
  const graph = makeGraph("order-service", [
    {
      id: "endpoint:src/OrderController.java:getOrder",
      type: "endpoint",
      name: "GET /orders/{id}",
      summary: "查询订单详情",
      tags: ["api"],
      complexity: "simple",
    },
  ]);
  const manifest = buildCommunityManifest({
    projectRoot: root,
    workspaceRoot: ws,
    graph,
    resolvedIdentity: identityOf("order-service", ["order.internal.com"], [contextPath]),
  });
  saveCommunityManifest(root, manifest);
  return root;
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "ua-linker-"));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe("验收场景 1：占位 → 回填", () => {
  it("creates a pending placeholder when the target community is not analyzed", () => {
    const { root, graph, signal } = setupRefundService();
    // order-service 尚未分析 → 空索引
    const index = loadSiblingManifests([root], root);
    const result = matchOutboundCall(index, signal);
    expect(result.status).toBe("pending");

    applyCommunityLinks(graph, [result]);
    const placeholder = graph.nodes.find((n) => n.type === "community");
    expect(placeholder).toBeDefined();
    expect(placeholder!.id).toBe(communityNodeId("order.internal.com"));
    expect(placeholder!.communityMeta!.status).toBe("pending");
    expect(graph.edges.filter((e) => e.type === "calls_community")).toHaveLength(1);
  });

  it("backfills the caller after the target is analyzed (no caller re-analysis)", () => {
    const { root: refundRoot, graph, signal } = setupRefundService();

    // 第一步：refund 分析时 order 未分析 → 占位 + outbound-links
    const emptyIndex = loadSiblingManifests([refundRoot], refundRoot);
    const pendingResult = matchOutboundCall(emptyIndex, signal);
    applyCommunityLinks(graph, [pendingResult]);
    writeFileSync(
      join(refundRoot, ".understand-anything", "knowledge-graph.json"),
      JSON.stringify(graph, null, 2),
    );
    saveOutboundLinks(refundRoot, toOutboundLinks("refund-service", [pendingResult]));

    // 第二步：order-service 完成分析 → 反向 backfill
    const orderRoot = setupOrderService();
    const orderManifest = JSON.parse(
      readFileSync(join(orderRoot, ".understand-anything", "community-manifest.json"), "utf8"),
    );
    const summary = backfillSiblingProject(refundRoot, orderManifest);

    expect(summary).not.toBeNull();
    expect(summary!.resolved).toBe(1);

    // outbound-links 已更新为 resolved + 全局限定 remoteRef
    const links = loadOutboundLinks(refundRoot)!;
    expect(links.links[0].status).toBe("resolved");
    expect(links.links[0].remoteRef).toEqual({
      serviceId: "order-service",
      graphKind: "structural",
      nodeId: "endpoint:src/OrderController.java:getOrder",
    });

    // refund 的图谱中占位节点升级为 resolved 且以 serviceId 为 ID
    const updated = JSON.parse(
      readFileSync(join(refundRoot, ".understand-anything", "knowledge-graph.json"), "utf8"),
    ) as KnowledgeGraph;
    const portal = updated.nodes.find((n) => n.type === "community");
    expect(portal!.id).toBe(communityNodeId("order-service"));
    expect(portal!.communityMeta!.status).toBe("resolved");
    const edge = updated.edges.find((e) => e.type === "calls_community")!;
    expect(edge.target).toBe(communityNodeId("order-service"));
    expect(edge.communityMeta!.status).toBe("resolved");
    expect(edge.communityMeta!.remoteRef!.nodeId).toBe("endpoint:src/OrderController.java:getOrder");
  });
});

describe("验收场景 2：共享域名 + contextPath 消歧", () => {
  it("resolves to the correct service when two services share a domain", () => {
    // 两个服务共享 api.company.com，contextPath 不同
    const orderRoot = join(ws, "order-service");
    mkdirSync(join(orderRoot, ".understand-anything"), { recursive: true });
    saveCommunityManifest(
      orderRoot,
      buildCommunityManifest({
        projectRoot: orderRoot,
        workspaceRoot: ws,
        graph: makeGraph("order-service", [
          { id: "endpoint:order:getOrder", type: "endpoint", name: "GET /orders/{id}", summary: "", tags: [], complexity: "simple" },
        ]),
        resolvedIdentity: identityOf("order-service", ["api.company.com"], ["/order-api"]),
      }),
    );

    const paymentRoot = join(ws, "payment-service");
    mkdirSync(join(paymentRoot, ".understand-anything"), { recursive: true });
    saveCommunityManifest(
      paymentRoot,
      buildCommunityManifest({
        projectRoot: paymentRoot,
        workspaceRoot: ws,
        graph: makeGraph("payment-service", [
          { id: "endpoint:payment:pay", type: "endpoint", name: "POST /pay", summary: "", tags: [], complexity: "simple" },
        ]),
        resolvedIdentity: identityOf("payment-service", ["api.company.com"], ["/payment-api"]),
      }),
    );

    const refundRoot = join(ws, "refund-service");
    mkdirSync(refundRoot, { recursive: true });
    const index = loadSiblingManifests([orderRoot, paymentRoot, refundRoot], refundRoot);

    const result = matchOutboundCall(index, {
      sourceNodeId: "endpoint:refund:q",
      domain: "api.company.com",
      method: "GET",
      path: "/order-api/orders/{param}",
    });
    expect(result.status).toBe("resolved");
    expect(result.targetServiceId).toBe("order-service");
  });
});

describe("验收场景 3：匹配失败标 ambiguous，不自动连线", () => {
  it("marks ambiguous when two services expose the same route", () => {
    for (const name of ["order-a", "order-b"]) {
      const root = join(ws, name);
      mkdirSync(join(root, ".understand-anything"), { recursive: true });
      saveCommunityManifest(
        root,
        buildCommunityManifest({
          projectRoot: root,
          workspaceRoot: ws,
          graph: makeGraph(name, [
            { id: `endpoint:${name}:getOrder`, type: "endpoint", name: "GET /orders/{id}", summary: "", tags: [], complexity: "simple" },
          ]),
          resolvedIdentity: identityOf(name, ["api.company.com"], ["/order-api"]),
        }),
      );
    }

    const refundRoot = join(ws, "refund-service");
    mkdirSync(refundRoot, { recursive: true });
    const index = loadSiblingManifests([join(ws, "order-a"), join(ws, "order-b"), refundRoot], refundRoot);

    const result = matchOutboundCall(index, {
      sourceNodeId: "endpoint:refund:q",
      domain: "api.company.com",
      method: "GET",
      path: "/order-api/orders/{param}",
    });
    expect(result.status).toBe("ambiguous");
    expect(result.candidates.length).toBe(2);
    // 策略 A：不自动选择 → 无 remoteRef
    expect(result.remoteRef).toBeUndefined();
  });
});

describe("验收场景 4：contextPath 变更 → stale", () => {
  it("marks previously resolved links stale when the route disappears", () => {
    const { root: refundRoot, graph, signal } = setupRefundService();

    // 初始：order-service contextPath=/order-api → resolved
    const orderRoot = setupOrderService("/order-api");
    let index = loadSiblingManifests([orderRoot, refundRoot], refundRoot);
    const resolved = matchOutboundCall(index, signal);
    expect(resolved.status).toBe("resolved");
    applyCommunityLinks(graph, [resolved]);
    writeFileSync(
      join(refundRoot, ".understand-anything", "knowledge-graph.json"),
      JSON.stringify(graph, null, 2),
    );
    saveOutboundLinks(refundRoot, toOutboundLinks("refund-service", [resolved]));

    // order-service 修改 contextPath 为 /api/order 并重新分析
    const newManifest = buildCommunityManifest({
      projectRoot: orderRoot,
      workspaceRoot: ws,
      graph: makeGraph("order-service", [
        { id: "endpoint:src/OrderController.java:getOrder", type: "endpoint", name: "GET /orders/{id}", summary: "", tags: [], complexity: "simple" },
      ]),
      resolvedIdentity: identityOf("order-service", ["order.internal.com"], ["/api/order"]),
    });
    saveCommunityManifest(orderRoot, newManifest);

    // 反向 backfill：旧 fullPath 不再匹配 → stale
    const summary = backfillSiblingProject(refundRoot, newManifest);
    expect(summary).not.toBeNull();
    expect(summary!.stale).toBe(1);

    const links = loadOutboundLinks(refundRoot)!;
    expect(links.links[0].status).toBe("stale");

    const updated = JSON.parse(
      readFileSync(join(refundRoot, ".understand-anything", "knowledge-graph.json"), "utf8"),
    ) as KnowledgeGraph;
    const edge = updated.edges.find((e) => e.type === "calls_community")!;
    expect(edge.communityMeta!.status).toBe("stale");
  });
});

describe("辅助行为", () => {
  it("stripCommunityArtifacts removes generated nodes and edges (idempotent re-apply)", () => {
    const { graph, signal } = setupRefundService();
    const result = matchOutboundCall(
      { byDomain: new Map(), byAlias: new Map(), byServiceId: new Map(), all: [] },
      signal,
    );
    applyCommunityLinks(graph, [result]);
    expect(graph.nodes.some((n) => n.type === "community")).toBe(true);

    stripCommunityArtifacts(graph);
    expect(graph.nodes.some((n) => n.type === "community")).toBe(false);
    expect(graph.edges.some((e) => e.type === "calls_community")).toBe(false);
  });

  it("backfill returns null when the sibling has no links to the current project", () => {
    const refundRoot = join(ws, "refund-service");
    mkdirSync(join(refundRoot, ".understand-anything"), { recursive: true });
    const unrelated: OutboundLinksFile = {
      serviceId: "refund-service",
      generatedAt: "2026-06-11T00:00:00.000Z",
      links: [
        {
          sourceNodeId: "endpoint:x",
          status: "pending",
          matchHints: { domain: "other.internal.com", fullPath: "/x" },
        },
      ],
    };
    saveOutboundLinks(refundRoot, unrelated);

    const orderRoot = setupOrderService();
    const manifest = JSON.parse(
      readFileSync(join(orderRoot, ".understand-anything", "community-manifest.json"), "utf8"),
    );
    expect(backfillSiblingProject(refundRoot, manifest)).toBeNull();
  });
});
