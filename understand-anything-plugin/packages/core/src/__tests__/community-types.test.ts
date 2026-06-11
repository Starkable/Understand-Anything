import { describe, it, expect } from "vitest";
import { validateGraph, GRAPH_SCHEMA_VERSION } from "../schema.js";
import type { KnowledgeGraph } from "../types.js";

// 跨项目社区联邦图谱样例：退费服务调用订单服务
const communityGraph: KnowledgeGraph = {
  version: "1.1.0",
  project: {
    name: "refund-service",
    languages: ["typescript"],
    frameworks: [],
    description: "Refund service",
    analyzedAt: "2026-06-11T00:00:00.000Z",
    gitCommitHash: "abc123",
  },
  nodes: [
    {
      id: "endpoint:src/controller/refund.ts:queryRefund",
      type: "endpoint",
      name: "queryRefund",
      filePath: "src/controller/refund.ts",
      summary: "查询退费接口",
      tags: ["api-handler"],
      complexity: "moderate",
    },
    {
      id: "community:order-service",
      type: "community",
      name: "订单服务",
      summary: "外部社区（待分析）",
      tags: ["external", "community"],
      complexity: "simple",
      communityMeta: {
        status: "pending",
        serviceId: "order-service",
        domains: ["order.internal.com"],
        matchHints: {
          domain: "order.internal.com",
          method: "GET",
          fullPath: "/order-api/orders/{param}",
          contextPathHint: "/order-api",
        },
      },
    },
  ],
  edges: [
    {
      source: "endpoint:src/controller/refund.ts:queryRefund",
      target: "community:order-service",
      type: "calls_community",
      direction: "forward",
      description: "GET https://order.internal.com/order-api/orders/{id}",
      weight: 0.8,
      communityMeta: {
        status: "pending",
        serviceId: "order-service",
        matchHints: {
          domain: "order.internal.com",
          method: "GET",
          fullPath: "/order-api/orders/{param}",
        },
        confidence: 0.85,
      },
    },
  ],
  layers: [],
  tour: [],
};

describe("community federation types", () => {
  it("exposes graph schema version 1.1.0", () => {
    expect(GRAPH_SCHEMA_VERSION).toBe("1.1.0");
  });

  it("validates a graph with community node and calls_community edge", () => {
    const result = validateGraph(communityGraph);
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.nodes).toHaveLength(2);
    expect(result.data!.edges).toHaveLength(1);
    expect(result.data!.edges[0].type).toBe("calls_community");
  });

  it("preserves communityMeta on nodes through validation", () => {
    const result = validateGraph(communityGraph);
    expect(result.success).toBe(true);
    const communityNode = result.data!.nodes.find(
      (n) => n.id === "community:order-service",
    );
    expect(communityNode).toBeDefined();
    const meta = (communityNode as any).communityMeta;
    expect(meta.status).toBe("pending");
    expect(meta.serviceId).toBe("order-service");
    expect(meta.matchHints.fullPath).toBe("/order-api/orders/{param}");
  });

  it("preserves communityMeta on edges through validation", () => {
    const result = validateGraph(communityGraph);
    expect(result.success).toBe(true);
    const meta = (result.data!.edges[0] as any).communityMeta;
    expect(meta.status).toBe("pending");
    expect(meta.confidence).toBe(0.85);
  });

  it("validates a resolved edge with globally-qualified remoteRef", () => {
    const graph = structuredClone(communityGraph);
    (graph.edges[0] as any).communityMeta = {
      status: "resolved",
      serviceId: "order-service",
      projectRef: "order-service",
      remoteRef: {
        serviceId: "order-service",
        graphKind: "structural",
        nodeId: "endpoint:src/controller/order.ts:getOrder",
      },
      remoteDisplayName: "查询订单详情",
      confidence: 0.95,
    };
    const result = validateGraph(graph);
    expect(result.success).toBe(true);
    const meta = (result.data!.edges[0] as any).communityMeta;
    expect(meta.remoteRef.serviceId).toBe("order-service");
    expect(meta.remoteRef.graphKind).toBe("structural");
  });

  it("accepts all four community status values", () => {
    for (const status of ["pending", "resolved", "ambiguous", "stale"]) {
      const graph = structuredClone(communityGraph);
      (graph.nodes[1] as any).communityMeta.status = status;
      const result = validateGraph(graph);
      expect(result.success).toBe(true);
    }
  });

  it("drops community node with invalid status", () => {
    const graph = structuredClone(communityGraph);
    (graph.nodes[1] as any).communityMeta.status = "unknown-status";
    const result = validateGraph(graph);
    // 节点级校验失败 → 节点被丢弃（容错策略），但整体仍成功
    expect(result.success).toBe(true);
    expect(result.data!.nodes).toHaveLength(1);
    expect(result.issues.some((i) => i.level === "dropped")).toBe(true);
  });

  it("normalizes community node type aliases", () => {
    const graph = structuredClone(communityGraph);
    (graph.nodes[1] as any).type = "external_service";
    const result = validateGraph(graph);
    expect(result.success).toBe(true);
    expect(result.data!.nodes[1].type).toBe("community");
  });

  it("normalizes calls_community edge type aliases", () => {
    const graph = structuredClone(communityGraph);
    (graph.edges[0] as any).type = "calls_service";
    const result = validateGraph(graph);
    expect(result.success).toBe(true);
    expect(result.data!.edges[0].type).toBe("calls_community");
  });

  it("remains backward-compatible with 1.0.0 graphs (no community fields)", () => {
    const legacyGraph: KnowledgeGraph = {
      version: "1.0.0",
      project: {
        name: "legacy-project",
        languages: ["typescript"],
        frameworks: [],
        description: "",
        analyzedAt: "2026-01-01T00:00:00.000Z",
        gitCommitHash: "def456",
      },
      nodes: [
        {
          id: "file:src/index.ts",
          type: "file",
          name: "index.ts",
          filePath: "src/index.ts",
          summary: "Entry point",
          tags: ["entry-point"],
          complexity: "simple",
        },
      ],
      edges: [],
      layers: [],
      tour: [],
    };
    const result = validateGraph(legacyGraph);
    expect(result.success).toBe(true);
    expect(result.data!.version).toBe("1.0.0");
    expect(result.issues).toHaveLength(0);
  });
});
