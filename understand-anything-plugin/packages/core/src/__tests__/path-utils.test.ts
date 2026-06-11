import { describe, it, expect } from "vitest";
import {
  normalizeUrlPath,
  joinContextPath,
  pathPatternsMatch,
  pathHasContextPrefix,
  extractUrlParts,
  composeOutboundPath,
} from "../workspace/path-utils.js";
import { matchOutboundCall } from "../workspace/linker.js";
import type { ManifestIndex, SiblingManifest } from "../workspace/manifest.js";
import type { CommunityManifest } from "../types.js";

describe("normalizeUrlPath", () => {
  it("collapses duplicate slashes and strips trailing slash", () => {
    expect(normalizeUrlPath("//order-api///orders/")).toBe("/order-api/orders");
  });

  it("unifies parameter styles to {param}", () => {
    expect(normalizeUrlPath("/orders/{id}")).toBe("/orders/{param}");
    expect(normalizeUrlPath("/orders/:id")).toBe("/orders/{param}");
    expect(normalizeUrlPath("/orders/<id>")).toBe("/orders/{param}");
  });

  it("rewrites concrete ids only when requested", () => {
    expect(normalizeUrlPath("/orders/123")).toBe("/orders/123");
    expect(normalizeUrlPath("/orders/123", { collapseConcreteIds: true })).toBe("/orders/{param}");
    expect(
      normalizeUrlPath("/orders/550e8400-e29b-41d4-a716-446655440000", { collapseConcreteIds: true }),
    ).toBe("/orders/{param}");
  });

  it("ignores query strings", () => {
    expect(normalizeUrlPath("/orders?page=1")).toBe("/orders");
  });
});

describe("joinContextPath", () => {
  it("joins contextPath and controllerPath", () => {
    expect(joinContextPath("/order-api", "/orders/{id}")).toBe("/order-api/orders/{param}");
  });

  it("handles missing contextPath", () => {
    expect(joinContextPath(undefined, "/orders")).toBe("/orders");
  });
});

describe("pathPatternsMatch", () => {
  it("matches concrete path against parameterized pattern", () => {
    expect(pathPatternsMatch("/order-api/orders/123", "/order-api/orders/{id}")).toBe(true);
  });

  it("rejects different segment counts", () => {
    expect(pathPatternsMatch("/orders/123/items", "/orders/{id}")).toBe(false);
  });

  it("rejects different literal segments", () => {
    expect(pathPatternsMatch("/payment/pay", "/orders/{id}")).toBe(false);
  });
});

describe("pathHasContextPrefix", () => {
  it("accepts exact prefix at segment boundary", () => {
    expect(pathHasContextPrefix("/order-api/orders", "/order-api")).toBe(true);
    // "/order-api-v2" must NOT match the "/order-api" prefix
    expect(pathHasContextPrefix("/order-api-v2/orders", "/order-api")).toBe(false);
  });
});

describe("extractUrlParts / composeOutboundPath", () => {
  it("extracts domain and normalized path from a literal URL", () => {
    const parts = extractUrlParts("https://order.internal.com/order-api/orders/123?x=1");
    expect(parts).toEqual({
      domain: "order.internal.com",
      port: undefined,
      path: "/order-api/orders/{param}",
    });
  });

  it("rejects template-literal hosts", () => {
    expect(extractUrlParts("https://${ORDER_HOST}/orders/1")).toBeNull();
  });

  it("composes baseUrl path prefix with relative path", () => {
    const parts = composeOutboundPath("https://api.company.com/order-api", "/orders/123");
    expect(parts).toEqual({
      domain: "api.company.com",
      port: undefined,
      path: "/order-api/orders/{param}",
    });
  });
});

// ── 共享域名消歧（设计 D5 五步流水线） ──────────────────────────────────────

function manifestOf(
  serviceId: string,
  domains: string[],
  contextPaths: string[],
  routes: Array<{ nodeId: string; method?: string; fullPath: string }>,
): SiblingManifest {
  const manifest: CommunityManifest = {
    serviceId,
    displayName: serviceId,
    projectPath: serviceId,
    analyzedAt: "2026-06-11T00:00:00.000Z",
    identity: { domains, aliases: [], contextPaths },
    routeCatalog: routes.map((r) => ({
      nodeId: r.nodeId,
      method: r.method,
      controllerPath: r.fullPath,
      fullPath: r.fullPath,
    })),
    graphRefs: { structural: ".understand-anything/knowledge-graph.json" },
  };
  return { manifest, projectRoot: `/ws/${serviceId}` };
}

function indexOf(...siblings: SiblingManifest[]): ManifestIndex {
  const index: ManifestIndex = { byDomain: new Map(), byAlias: new Map(), byServiceId: new Map(), all: siblings };
  for (const s of siblings) {
    index.byServiceId.set(s.manifest.serviceId, s);
    for (const d of s.manifest.identity.domains) {
      const list = index.byDomain.get(d.toLowerCase()) ?? [];
      list.push(s);
      index.byDomain.set(d.toLowerCase(), list);
    }
  }
  return index;
}

describe("shared-domain disambiguation (matchOutboundCall)", () => {
  const order = manifestOf(
    "order-service",
    ["api.company.com"],
    ["/order-api"],
    [{ nodeId: "endpoint:order:getOrder", method: "GET", fullPath: "/order-api/orders/{param}" }],
  );
  const payment = manifestOf(
    "payment-service",
    ["api.company.com"],
    ["/payment-api"],
    [{ nodeId: "endpoint:payment:pay", method: "POST", fullPath: "/payment-api/pay" }],
  );

  it("resolves the correct community via contextPath under a shared domain", () => {
    const result = matchOutboundCall(indexOf(order, payment), {
      sourceNodeId: "endpoint:refund:queryRefund",
      domain: "api.company.com",
      method: "GET",
      path: "/order-api/orders/{param}",
    });
    expect(result.status).toBe("resolved");
    expect(result.targetServiceId).toBe("order-service");
    expect(result.remoteRef).toEqual({
      serviceId: "order-service",
      graphKind: "structural",
      nodeId: "endpoint:order:getOrder",
    });
  });

  it("marks ambiguous when multiple services match the same route", () => {
    const orderClone = manifestOf(
      "order-v2",
      ["api.company.com"],
      ["/order-api"],
      [{ nodeId: "endpoint:order2:getOrder", method: "GET", fullPath: "/order-api/orders/{param}" }],
    );
    const result = matchOutboundCall(indexOf(order, orderClone), {
      sourceNodeId: "endpoint:refund:queryRefund",
      domain: "api.company.com",
      method: "GET",
      path: "/order-api/orders/{param}",
    });
    expect(result.status).toBe("ambiguous");
    expect(result.candidates).toHaveLength(2);
  });

  it("returns pending placeholder for unknown domains", () => {
    const result = matchOutboundCall(indexOf(order), {
      sourceNodeId: "endpoint:refund:queryRefund",
      domain: "unknown.internal.com",
      method: "GET",
      path: "/whatever",
    });
    expect(result.status).toBe("pending");
    expect(result.targetServiceId).toBeUndefined();
  });

  it("returns pending with targetServiceId when domain+contextPath identify a service but no route matches", () => {
    const result = matchOutboundCall(indexOf(order, payment), {
      sourceNodeId: "endpoint:refund:queryRefund",
      domain: "api.company.com",
      method: "DELETE",
      path: "/order-api/legacy/remove/{param}",
    });
    expect(result.status).toBe("pending");
    expect(result.targetServiceId).toBe("order-service");
  });

  it("rejects method mismatches", () => {
    const result = matchOutboundCall(indexOf(order), {
      sourceNodeId: "endpoint:refund:queryRefund",
      domain: "api.company.com",
      method: "POST",
      path: "/order-api/orders/{param}",
    });
    // POST 不匹配 GET 路由 → 无路由命中 → contextPath 指认服务 → pending
    expect(result.status).toBe("pending");
    expect(result.targetServiceId).toBe("order-service");
  });
});
