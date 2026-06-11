/**
 * Federation graph aggregation (design D9, runtime-only — never persisted
 * as a source of truth; rebuilt from manifests + outbound-links on demand).
 *
 * The federation graph is intentionally tiny: one `community` node per
 * project (plus placeholder nodes for referenced-but-unanalyzed targets)
 * and ONE aggregated `calls_community` edge per (caller, callee) pair with
 * a call count, regardless of how many concrete call sites exist.
 */
import type { GraphNode, GraphEdge, CommunityMeta } from "../types.js";
import { loadCommunityManifest, loadOutboundLinks } from "./manifest.js";
import { communityNodeId } from "./linker.js";

const LOG_PREFIX = "[federation]";

export interface FederationGraph {
  version: string;
  kind: "federation";
  generatedAt: string;
  nodes: GraphNode[];
  edges: Array<GraphEdge & { callCount: number }>;
}

/**
 * Aggregate all workspace manifests + outbound links into a federation graph.
 * Projects without a manifest are invisible unless referenced by another
 * project's outbound links (then they appear as pending placeholders).
 */
export function buildFederationGraph(projectRoots: string[]): FederationGraph {
  const nodes = new Map<string, GraphNode>();
  // key: callerServiceId → calleeNodeId → { count, statuses }
  const edgeAgg = new Map<string, Map<string, { count: number; statuses: Set<CommunityMeta["status"]> }>>();

  // 1. Analyzed communities (manifest exists)
  for (const root of projectRoots) {
    const manifest = loadCommunityManifest(root);
    if (!manifest) continue;
    const id = communityNodeId(manifest.serviceId);
    nodes.set(id, {
      id,
      type: "community",
      name: manifest.displayName,
      summary: `Service community "${manifest.serviceId}" (${manifest.routeCatalog.length} routes)`,
      tags: ["community"],
      complexity: "simple",
      communityMeta: {
        status: "resolved",
        serviceId: manifest.serviceId,
        domains: manifest.identity.domains,
        projectRef: manifest.projectPath,
      },
    });
  }

  // 2. Outbound links → aggregated edges (+ placeholder targets)
  for (const root of projectRoots) {
    const outbound = loadOutboundLinks(root);
    if (!outbound) continue;
    const callerId = communityNodeId(outbound.serviceId);
    if (!nodes.has(callerId)) {
      // Caller analyzed enough to have links but lost its manifest — still show it
      nodes.set(callerId, placeholderNode(outbound.serviceId, outbound.serviceId));
    }

    for (const link of outbound.links) {
      const targetKey = link.targetServiceId ?? link.matchHints.domain ?? "unknown";
      const targetId = communityNodeId(targetKey);
      if (!nodes.has(targetId)) {
        nodes.set(targetId, placeholderNode(targetKey, link.targetServiceId ?? targetKey));
      }

      const perCaller = edgeAgg.get(callerId) ?? new Map();
      const agg = perCaller.get(targetId) ?? { count: 0, statuses: new Set<CommunityMeta["status"]>() };
      agg.count++;
      agg.statuses.add(link.status);
      perCaller.set(targetId, agg);
      edgeAgg.set(callerId, perCaller);
    }
  }

  // 3. Materialize aggregated edges. Edge-level status: worst-of statuses
  //    (ambiguous > stale > pending > resolved) so problems stay visible.
  const severity: CommunityMeta["status"][] = ["ambiguous", "stale", "pending", "resolved"];
  const edges: Array<GraphEdge & { callCount: number }> = [];
  for (const [callerId, targets] of edgeAgg) {
    for (const [targetId, agg] of targets) {
      if (callerId === targetId) continue; // self-references add no information
      const status = severity.find((s) => agg.statuses.has(s)) ?? "pending";
      edges.push({
        source: callerId,
        target: targetId,
        type: "calls_community",
        direction: "forward",
        description: `${agg.count} call site(s)`,
        weight: Math.min(1, 0.4 + agg.count * 0.1),
        callCount: agg.count,
        communityMeta: { status },
      });
    }
  }

  console.error(
    `${LOG_PREFIX} aggregated ${nodes.size} community node(s), ${edges.length} edge(s) from ${projectRoots.length} project(s)`,
  );
  return {
    version: "1.1.0",
    kind: "federation",
    generatedAt: new Date().toISOString(),
    nodes: [...nodes.values()],
    edges,
  };
}

function placeholderNode(key: string, name: string): GraphNode {
  return {
    id: communityNodeId(key),
    type: "community",
    name,
    summary: `External service (not analyzed yet)`,
    tags: ["community", "placeholder"],
    complexity: "simple",
    communityMeta: { status: "pending", domains: key.includes(".") ? [key] : undefined },
  };
}
