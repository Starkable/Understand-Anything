import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveWorkspaceRoot,
  loadWorkspaceConfig,
  discoverProjects,
} from "../workspace/workspace.js";
import {
  parseReadmeFrontmatter,
  resolveCommunityIdentity,
} from "../workspace/identity.js";
import {
  buildRouteCatalog,
  buildCommunityManifest,
  saveCommunityManifest,
  loadCommunityManifest,
  loadSiblingManifests,
  parseEndpointSignature,
} from "../workspace/manifest.js";
import type { KnowledgeGraph } from "../types.js";
import type { ResolvedCommunityIdentity } from "../workspace/identity.js";

let workspaceRoot: string;

function makeProject(name: string, files: Record<string, string> = {}): string {
  const root = join(workspaceRoot, name);
  mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return root;
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ua-workspace-"));
  delete process.env.UNDERSTAND_WORKSPACE_ROOT;
});

afterEach(() => {
  delete process.env.UNDERSTAND_WORKSPACE_ROOT;
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("workspace discovery", () => {
  it("resolves workspace root from environment variable", () => {
    process.env.UNDERSTAND_WORKSPACE_ROOT = workspaceRoot;
    const project = makeProject("refund-service");
    expect(resolveWorkspaceRoot(project)).toBe(workspaceRoot);
  });

  it("resolves workspace root by finding .understand-workspace.json upward", () => {
    writeFileSync(join(workspaceRoot, ".understand-workspace.json"), JSON.stringify({ version: "1" }));
    const project = makeProject("refund-service");
    expect(resolveWorkspaceRoot(project)).toBe(workspaceRoot);
  });

  it("returns null (offline mode) when nothing is configured", () => {
    const project = makeProject("refund-service");
    expect(resolveWorkspaceRoot(project)).toBeNull();
  });

  it("loads explicit project list from config", () => {
    writeFileSync(
      join(workspaceRoot, ".understand-workspace.json"),
      JSON.stringify({ version: "1", projects: ["a-service", "b-service"] }),
    );
    makeProject("a-service");
    makeProject("b-service");
    const config = loadWorkspaceConfig(workspaceRoot);
    expect(config.projects).toEqual(["a-service", "b-service"]);
    const projects = discoverProjects(workspaceRoot, config);
    expect(projects).toHaveLength(2);
  });

  it("auto-scans subdirectories containing .understand-anything", () => {
    makeProject("analyzed-service", { ".understand-anything/meta.json": "{}" });
    makeProject("raw-service"); // never analyzed → invisible
    const projects = discoverProjects(workspaceRoot);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toContain("analyzed-service");
  });

  it("skips configured projects missing on disk", () => {
    writeFileSync(
      join(workspaceRoot, ".understand-workspace.json"),
      JSON.stringify({ version: "1", projects: ["exists", "missing"] }),
    );
    makeProject("exists");
    const projects = discoverProjects(workspaceRoot);
    expect(projects).toHaveLength(1);
  });
});

describe("README community identity", () => {
  const FRONTMATTER_README = `---
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
# Order Service
`;

  it("parses understand-community frontmatter", () => {
    const fm = parseReadmeFrontmatter(FRONTMATTER_README);
    expect(fm).not.toBeNull();
    expect(fm!.serviceId).toBe("order-service");
  });

  it("returns null when no frontmatter exists", () => {
    expect(parseReadmeFrontmatter("# Plain README\n")).toBeNull();
  });

  it("resolves full identity from README", () => {
    const project = makeProject("order-service", { "README.md": FRONTMATTER_README });
    const resolved = resolveCommunityIdentity(project);
    expect(resolved.serviceId).toBe("order-service");
    expect(resolved.displayName).toBe("订单信息");
    expect(resolved.identity.domains).toEqual(["order.internal.com", "api.company.com"]);
    expect(resolved.identity.contextPaths).toEqual(["/order-api"]);
    expect(resolved.source).toBe("readme");
    expect(resolved.needsReadmeUpdate).toBe(false);
  });

  it("falls back to package.json name and writes sidecar", () => {
    const project = makeProject("some-dir", {
      "README.md": "# No frontmatter\n",
      "package.json": JSON.stringify({ name: "@org/payment-service" }),
    });
    const resolved = resolveCommunityIdentity(project);
    expect(resolved.serviceId).toBe("payment-service"); // scope stripped
    expect(resolved.source).toBe("package-json");
    expect(resolved.needsReadmeUpdate).toBe(true);
    // Sidecar written, README untouched
    const sidecar = join(project, ".understand-anything", "community-identity.json");
    expect(existsSync(sidecar)).toBe(true);
    expect(readFileSync(join(project, "README.md"), "utf8")).toBe("# No frontmatter\n");
  });

  it("falls back to directory name as last resort", () => {
    const project = makeProject("legacy-service");
    const resolved = resolveCommunityIdentity(project);
    expect(resolved.serviceId).toBe("legacy-service");
    expect(resolved.source).toBe("directory-name");
  });
});

function makeGraph(nodes: KnowledgeGraph["nodes"]): KnowledgeGraph {
  return {
    version: "1.1.0",
    project: {
      name: "t",
      languages: [],
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

const fakeIdentity = (overrides: Partial<ResolvedCommunityIdentity["identity"]> = {}): ResolvedCommunityIdentity => ({
  serviceId: "order-service",
  displayName: "订单信息",
  identity: { domains: ["order.internal.com"], aliases: [], contextPaths: [], ...overrides },
  source: "readme",
  needsReadmeUpdate: false,
});

describe("community manifest", () => {
  it("parses endpoint signatures", () => {
    expect(parseEndpointSignature("GET /orders/{id}")).toEqual({ method: "GET", path: "/orders/{id}" });
    expect(parseEndpointSignature("post /api/refund")).toEqual({ method: "POST", path: "/api/refund" });
    expect(parseEndpointSignature("no path here")).toBeNull();
  });

  it("builds routeCatalog with contextPath-synthesized fullPath", () => {
    const graph = makeGraph([
      {
        id: "endpoint:src/OrderController.java:getOrder",
        type: "endpoint",
        name: "GET /orders/{id}",
        summary: "查询订单",
        tags: ["api"],
        complexity: "simple",
      },
    ]);
    const catalog = buildRouteCatalog(graph, ["/order-api"]);
    expect(catalog).toHaveLength(1);
    expect(catalog[0].fullPath).toBe("/order-api/orders/{param}");
    expect(catalog[0].contextPath).toBe("/order-api");
    expect(catalog[0].nodeId).toBe("endpoint:src/OrderController.java:getOrder");
  });

  it("does not double-prefix when controllerPath already includes contextPath", () => {
    const graph = makeGraph([
      {
        id: "endpoint:a",
        type: "endpoint",
        name: "GET /order-api/orders/{id}",
        summary: "",
        tags: [],
        complexity: "simple",
      },
    ]);
    const catalog = buildRouteCatalog(graph, ["/order-api"]);
    expect(catalog).toHaveLength(1);
    expect(catalog[0].fullPath).toBe("/order-api/orders/{param}");
  });

  it("round-trips manifest save/load and builds the sibling index", () => {
    const orderRoot = makeProject("order-service", { ".understand-anything/meta.json": "{}" });
    const refundRoot = makeProject("refund-service", { ".understand-anything/meta.json": "{}" });

    const graph = makeGraph([
      {
        id: "endpoint:src/OrderController.java:getOrder",
        type: "endpoint",
        name: "GET /orders/{id}",
        summary: "查询订单",
        tags: ["api"],
        complexity: "simple",
      },
    ]);
    const manifest = buildCommunityManifest({
      projectRoot: orderRoot,
      workspaceRoot,
      graph,
      resolvedIdentity: fakeIdentity({ contextPaths: ["/order-api"] }),
    });
    saveCommunityManifest(orderRoot, manifest);

    const loaded = loadCommunityManifest(orderRoot);
    expect(loaded).not.toBeNull();
    expect(loaded!.serviceId).toBe("order-service");
    expect(loaded!.routeCatalog[0].fullPath).toBe("/order-api/orders/{param}");

    // Sibling index: analyzing refund-service must see order-service only
    const index = loadSiblingManifests([orderRoot, refundRoot], refundRoot);
    expect(index.all).toHaveLength(1);
    expect(index.byDomain.get("order.internal.com")).toHaveLength(1);
    expect(index.byServiceId.has("order-service")).toBe(true);
  });
});
