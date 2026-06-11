import { describe, it, expect } from "vitest";
import { buildFederationFlow } from "../federationFlow";
import type { FederationGraphData } from "../../store";
import { EDGE_CATEGORY_MAP, ALL_NODE_TYPES, ALL_EDGE_CATEGORIES, useDashboardStore } from "../../store";

function makeFederationGraph(): FederationGraphData {
  return {
    version: "1.1.0",
    kind: "federation",
    generatedAt: new Date().toISOString(),
    nodes: [
      {
        id: "community:refund-service",
        type: "community",
        name: "refund-service",
        summary: 'Service community "refund-service" (3 routes)',
        tags: ["community"],
        complexity: "simple",
        communityMeta: {
          status: "resolved",
          serviceId: "refund-service",
          domains: ["refund.internal.example.com"],
        },
      },
      {
        id: "community:order-service",
        type: "community",
        name: "order-service",
        summary: "External service (not analyzed yet)",
        tags: ["community", "placeholder"],
        complexity: "simple",
        communityMeta: { status: "pending", domains: ["order.internal.example.com"] },
      },
    ],
    edges: [
      {
        source: "community:refund-service",
        target: "community:order-service",
        type: "calls_community",
        direction: "forward",
        description: "2 call site(s)",
        weight: 0.6,
        callCount: 2,
        communityMeta: { status: "pending" },
      },
    ],
  };
}

describe("buildFederationFlow", () => {
  it("maps community nodes to React Flow community-node cards", () => {
    const { nodes, dims } = buildFederationFlow(makeFederationGraph(), "call site(s)");
    expect(nodes).toHaveLength(2);
    const refund = nodes.find((n) => n.id === "community:refund-service");
    expect(refund?.type).toBe("community-node");
    expect(refund?.data).toMatchObject({
      label: "refund-service",
      serviceId: "refund-service",
      domains: ["refund.internal.example.com"],
      status: "resolved",
    });
    // Every node must have dims registered for ELK layout
    expect(dims.has("community:refund-service")).toBe(true);
    expect(dims.has("community:order-service")).toBe(true);
  });

  it("defaults missing communityMeta to pending status", () => {
    const graph = makeFederationGraph();
    delete graph.nodes[1].communityMeta;
    const { nodes } = buildFederationFlow(graph, "call site(s)");
    const order = nodes.find((n) => n.id === "community:order-service");
    expect((order?.data as { status: string }).status).toBe("pending");
  });

  it("maps calls_community edges with call count label and status styling", () => {
    const { edges } = buildFederationFlow(makeFederationGraph(), "call site(s)");
    expect(edges).toHaveLength(1);
    const edge = edges[0];
    expect(edge.source).toBe("community:refund-service");
    expect(edge.target).toBe("community:order-service");
    expect(edge.label).toBe("2 call site(s)");
    // pending edges are dashed and not animated
    expect((edge.style as { strokeDasharray?: string }).strokeDasharray).toBe("6 4");
    expect(edge.animated).toBe(false);
  });

  it("animates resolved edges and uses solid stroke", () => {
    const graph = makeFederationGraph();
    graph.edges[0].communityMeta = { status: "resolved" };
    const { edges } = buildFederationFlow(graph, "call site(s)");
    expect(edges[0].animated).toBe(true);
    expect((edges[0].style as { strokeDasharray?: string }).strokeDasharray).toBeUndefined();
  });

  it("ignores non-community nodes and non-calls_community edges", () => {
    const graph = makeFederationGraph();
    graph.nodes.push({
      id: "file:src/index.ts",
      type: "file",
      name: "index.ts",
      summary: "entry",
      tags: [],
      complexity: "simple",
    });
    graph.edges.push({
      source: "community:refund-service",
      target: "file:src/index.ts",
      type: "calls",
      direction: "forward",
      description: "",
      weight: 0.5,
    });
    const { nodes, edges } = buildFederationFlow(graph, "call site(s)");
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(1);
  });
});

describe("store federation integration", () => {
  it("registers community node type and edge category", () => {
    expect(ALL_NODE_TYPES).toContain("community");
    expect(ALL_EDGE_CATEGORIES).toContain("community");
    expect(EDGE_CATEGORY_MAP.community).toEqual(["calls_community"]);
  });

  it("stores the federation graph and supports the federation view mode", () => {
    const graph = makeFederationGraph();
    useDashboardStore.getState().setFederationGraph(graph);
    expect(useDashboardStore.getState().federationGraph).toBe(graph);

    useDashboardStore.getState().setViewMode("federation");
    expect(useDashboardStore.getState().viewMode).toBe("federation");
    // Switching view clears node selection
    expect(useDashboardStore.getState().selectedNodeId).toBeNull();
  });
});
