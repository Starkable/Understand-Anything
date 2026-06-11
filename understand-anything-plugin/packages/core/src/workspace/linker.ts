/**
 * Cross-community matching engine and graph mutation (design D5/D7/D8).
 *
 * Matching pipeline for one outbound call:
 *   1. domain → candidate manifests (shared domains → several)
 *   2. contextPath prefix filter
 *   3. routeCatalog fullPath pattern match
 *   4. method check
 *   5. unique hit → resolved; several → ambiguous (policy A: never auto-pick);
 *      domain known but route unknown → pending with targetServiceId;
 *      domain unknown → pending placeholder
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  KnowledgeGraph,
  GraphNode,
  GraphEdge,
  CommunityMeta,
  CommunityManifest,
  RemoteNodeRef,
  OutboundLink,
  OutboundLinksFile,
  RouteCatalogEntry,
} from "../types.js";
import {
  type ManifestIndex,
  type SiblingManifest,
  loadOutboundLinks,
  saveOutboundLinks,
} from "./manifest.js";
import { pathPatternsMatch, pathHasContextPrefix, normalizeUrlPath } from "./path-utils.js";

const LOG_PREFIX = "[community-linker]";
const UA_DIR = ".understand-anything";
const GRAPH_FILE = "knowledge-graph.json";
const DOMAIN_GRAPH_FILE = "domain-graph.json";
const LOCK_FILE = "backfill.lock";
/** A lock older than this is considered abandoned and is overwritten. */
const LOCK_STALE_MS = 5 * 60 * 1000;

// ── Signals & match results ──────────────────────────────────────────────────

/** One outbound HTTP call discovered in the current project's source. */
export interface OutboundCallSignal {
  /** Graph node id (endpoint/function/file) that performs the call */
  sourceNodeId: string;
  domain: string;
  method?: string;
  /** Normalized outbound full path (baseUrl prefix + relative path) */
  path: string;
  description?: string;
  /** Discovery confidence 0-1 (literal URL = high, heuristic = low) */
  confidence?: number;
}

export interface MatchResult {
  signal: OutboundCallSignal;
  status: "resolved" | "pending" | "ambiguous";
  targetServiceId?: string;
  /** Workspace-relative path of the matched sibling project */
  projectRef?: string;
  remoteRef?: RemoteNodeRef;
  remoteDisplayName?: string;
  /** All candidate hits, populated for ambiguous results */
  candidates: Array<{ serviceId: string; nodeId: string; fullPath: string }>;
  confidence: number;
}

function methodCompatible(entryMethod: string | undefined, signalMethod: string | undefined): boolean {
  if (!entryMethod || !signalMethod) return true;
  return entryMethod.toUpperCase() === signalMethod.toUpperCase();
}

function routeMatches(entry: RouteCatalogEntry, signal: OutboundCallSignal): boolean {
  return methodCompatible(entry.method, signal.method) && pathPatternsMatch(entry.fullPath, signal.path);
}

/**
 * Match a single outbound call against the sibling manifest index.
 * Pure function — no filesystem access.
 */
export function matchOutboundCall(index: ManifestIndex, signal: OutboundCallSignal): MatchResult {
  const base: MatchResult = {
    signal,
    status: "pending",
    candidates: [],
    confidence: signal.confidence ?? 0.5,
  };

  const domainHits = index.byDomain.get(signal.domain.toLowerCase()) ?? [];
  if (domainHits.length === 0) {
    // Unknown domain — placeholder until some sibling claims it
    return base;
  }

  // Collect route-level hits across all candidate services
  const hits: Array<{ sibling: SiblingManifest; entry: RouteCatalogEntry }> = [];
  for (const sibling of domainHits) {
    for (const entry of sibling.manifest.routeCatalog) {
      if (routeMatches(entry, signal)) hits.push({ sibling, entry });
    }
  }

  // Dedupe identical (serviceId, nodeId) pairs (multi-context catalogs can
  // emit the same node twice)
  const uniqueByNode = new Map<string, { sibling: SiblingManifest; entry: RouteCatalogEntry }>();
  for (const hit of hits) {
    uniqueByNode.set(`${hit.sibling.manifest.serviceId}\u0000${hit.entry.nodeId}`, hit);
  }
  const unique = [...uniqueByNode.values()];

  if (unique.length === 1) {
    const { sibling, entry } = unique[0];
    return {
      ...base,
      status: "resolved",
      targetServiceId: sibling.manifest.serviceId,
      projectRef: sibling.manifest.projectPath,
      remoteRef: {
        serviceId: sibling.manifest.serviceId,
        graphKind: "structural",
        nodeId: entry.nodeId,
      },
      confidence: Math.min(1, (signal.confidence ?? 0.8) + 0.15),
    };
  }

  if (unique.length > 1) {
    // Several concrete endpoints match — policy A: surface, never pick
    return {
      ...base,
      status: "ambiguous",
      candidates: unique.map(({ sibling, entry }) => ({
        serviceId: sibling.manifest.serviceId,
        nodeId: entry.nodeId,
        fullPath: entry.fullPath,
      })),
      confidence: 0.4,
    };
  }

  // No route hit. Narrow by contextPath prefix to find the owning service.
  const prefixOwners = domainHits.filter((s) =>
    s.manifest.identity.contextPaths.some((ctx) => pathHasContextPrefix(signal.path, ctx)),
  );
  const owners = prefixOwners.length > 0 ? prefixOwners : domainHits;

  if (owners.length === 1) {
    // Community identified, concrete route unknown (may appear after the
    // target is re-analyzed) — stays pending with a known target.
    return {
      ...base,
      status: "pending",
      targetServiceId: owners[0].manifest.serviceId,
      projectRef: owners[0].manifest.projectPath,
    };
  }

  return {
    ...base,
    status: "ambiguous",
    candidates: owners.map((s) => ({
      serviceId: s.manifest.serviceId,
      nodeId: "",
      fullPath: "",
    })),
    confidence: 0.3,
  };
}

// ── remoteDisplayName resolution (task 4.7 / design D6) ─────────────────────

/**
 * Resolve a business-friendly display name for a remote endpoint node by
 * consulting the sibling's domain-graph.json (flow/step names). Falls back
 * to null — callers then display the endpoint's technical name.
 */
export function resolveRemoteDisplayName(
  siblingProjectRoot: string,
  remoteNodeId: string,
): string | null {
  const p = join(siblingProjectRoot, UA_DIR, DOMAIN_GRAPH_FILE);
  if (!existsSync(p)) return null;
  try {
    const graph = JSON.parse(readFileSync(p, "utf8")) as KnowledgeGraph;
    // 1. step/flow → implements → endpoint node
    const implEdge = graph.edges.find(
      (e) => e.type === "implements" && e.target === remoteNodeId,
    );
    if (implEdge) {
      const owner = graph.nodes.find((n) => n.id === implEdge.source);
      if (owner && (owner.type === "flow" || owner.type === "step")) return owner.name;
    }
    // 2. flow whose entryPoint mentions the endpoint's path
    const pathPart = /(\/[^\s]*)/.exec(remoteNodeId)?.[1];
    if (pathPart) {
      const flow = graph.nodes.find(
        (n) =>
          n.type === "flow" &&
          typeof n.domainMeta?.entryPoint === "string" &&
          n.domainMeta.entryPoint.includes(pathPart),
      );
      if (flow) return flow.name;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Graph mutation (task 4.3) ────────────────────────────────────────────────

export function communityNodeId(serviceIdOrDomain: string): string {
  return `community:${serviceIdOrDomain}`;
}

function buildEdgeMeta(result: MatchResult): CommunityMeta {
  return {
    status: result.status,
    serviceId: result.targetServiceId,
    projectRef: result.projectRef,
    remoteRef: result.remoteRef,
    remoteDisplayName: result.remoteDisplayName,
    matchHints: {
      domain: result.signal.domain,
      method: result.signal.method,
      fullPath: result.signal.path,
    },
    confidence: result.confidence,
  };
}

/**
 * Remove all previously generated community artifacts so re-applying is
 * idempotent (the resolve step fully owns community nodes + edges).
 */
export function stripCommunityArtifacts(graph: KnowledgeGraph): void {
  graph.edges = graph.edges.filter((e) => e.type !== "calls_community");
  graph.nodes = graph.nodes.filter((n) => n.type !== "community");
}

/**
 * Apply match results to the current project's graph: one community portal
 * node per target, one calls_community edge per (source, target, fullPath).
 * Mutates the graph in place and returns the created artifacts.
 */
export function applyCommunityLinks(
  graph: KnowledgeGraph,
  results: MatchResult[],
): { nodesAdded: number; edgesAdded: number } {
  const sourceIds = new Set(graph.nodes.map((n) => n.id));
  const communityNodes = new Map<string, GraphNode>();
  const edgeKeys = new Set<string>();
  let edgesAdded = 0;

  for (const result of results) {
    if (!sourceIds.has(result.signal.sourceNodeId)) {
      console.error(
        `${LOG_PREFIX} outbound source node not in graph: ${result.signal.sourceNodeId} — edge skipped`,
      );
      continue;
    }

    const targetKey = result.targetServiceId ?? result.signal.domain;
    const nodeId = communityNodeId(targetKey);

    // Portal node — one per target community; status reflects the "best"
    // result (resolved > pending > ambiguous handled by simple upgrade)
    let node = communityNodes.get(nodeId);
    if (!node) {
      node = {
        id: nodeId,
        type: "community",
        name: result.targetServiceId ?? result.signal.domain,
        summary: result.targetServiceId
          ? `External service community "${result.targetServiceId}"`
          : `External service at ${result.signal.domain} (not analyzed yet)`,
        tags: ["external", "community"],
        complexity: "simple",
        communityMeta: {
          status: result.status,
          serviceId: result.targetServiceId,
          domains: [result.signal.domain],
          projectRef: result.projectRef,
        },
      };
      communityNodes.set(nodeId, node);
    } else {
      const meta = node.communityMeta!;
      if (meta.status !== "resolved" && result.status === "resolved") meta.status = "resolved";
      if (!meta.domains!.includes(result.signal.domain)) meta.domains!.push(result.signal.domain);
    }

    const edgeKey = `${result.signal.sourceNodeId}\u0000${nodeId}\u0000${result.signal.method ?? ""} ${result.signal.path}`;
    if (edgeKeys.has(edgeKey)) continue;
    edgeKeys.add(edgeKey);

    const edge: GraphEdge = {
      source: result.signal.sourceNodeId,
      target: nodeId,
      type: "calls_community",
      direction: "forward",
      description:
        result.signal.description ??
        `${result.signal.method ?? "HTTP"} ${result.signal.domain}${result.signal.path}`,
      weight: result.status === "resolved" ? 0.8 : 0.5,
      communityMeta: buildEdgeMeta(result),
    };
    graph.edges.push(edge);
    edgesAdded++;
  }

  for (const node of communityNodes.values()) graph.nodes.push(node);
  console.error(
    `${LOG_PREFIX} applied ${edgesAdded} calls_community edge(s), ${communityNodes.size} community node(s)`,
  );
  return { nodesAdded: communityNodes.size, edgesAdded };
}

/** Convert match results into the outbound-links.json payload. */
export function toOutboundLinks(serviceId: string, results: MatchResult[]): OutboundLinksFile {
  const links: OutboundLink[] = results.map((r) => ({
    sourceNodeId: r.signal.sourceNodeId,
    targetServiceId: r.targetServiceId,
    status: r.status,
    matchHints: {
      domain: r.signal.domain,
      method: r.signal.method,
      fullPath: r.signal.path,
    },
    remoteRef: r.remoteRef,
    remoteDisplayName: r.remoteDisplayName,
    confidence: r.confidence,
  }));
  return { serviceId, generatedAt: new Date().toISOString(), links };
}

// ── Reverse backfill & stale scan (tasks 4.5 / 4.6, design D7/D8) ───────────

export interface BackfillSummary {
  siblingProjectRoot: string;
  siblingServiceId: string;
  resolved: number;
  stale: number;
  unchanged: number;
}

/** Does this link refer to the given manifest (by serviceId or claimed domain)? */
function linkTargetsManifest(link: OutboundLink, manifest: CommunityManifest): boolean {
  if (link.targetServiceId && link.targetServiceId === manifest.serviceId) return true;
  const domain = link.matchHints.domain?.toLowerCase();
  return !!domain && manifest.identity.domains.some((d) => d.toLowerCase() === domain);
}

/** Re-match a stored link against ONE manifest (the freshly analyzed project). */
function rematchLink(
  link: OutboundLink,
  manifest: CommunityManifest,
): { status: OutboundLink["status"]; remoteRef?: RemoteNodeRef } {
  const path = link.matchHints.fullPath ? normalizeUrlPath(link.matchHints.fullPath) : null;
  if (!path) {
    return { status: link.targetServiceId ? "pending" : link.status };
  }
  const hits = manifest.routeCatalog.filter(
    (entry) =>
      methodCompatible(entry.method, link.matchHints.method) &&
      pathPatternsMatch(entry.fullPath, path),
  );
  const uniqueNodes = [...new Set(hits.map((h) => h.nodeId))];
  if (uniqueNodes.length === 1) {
    return {
      status: "resolved",
      remoteRef: { serviceId: manifest.serviceId, graphKind: "structural", nodeId: uniqueNodes[0] },
    };
  }
  if (uniqueNodes.length > 1) return { status: "ambiguous" };
  // No route in the fresh catalog:
  //   previously resolved → the route disappeared → stale (design D8)
  //   previously pending  → still pending
  return { status: link.status === "resolved" ? "stale" : "pending" };
}

/**
 * Backfill ONE sibling project after the current project has been analyzed.
 *
 * Updates the sibling's outbound-links.json and the community metadata inside
 * its knowledge-graph.json. Never triggers any LLM work and never commits —
 * the caller reports modified paths to the user (design D7).
 *
 * Returns null when the sibling has no links pointing at the current project.
 */
export function backfillSiblingProject(
  siblingProjectRoot: string,
  currentManifest: CommunityManifest,
): BackfillSummary | null {
  const outbound = loadOutboundLinks(siblingProjectRoot);
  if (!outbound) return null;

  const relevant = outbound.links.filter((l) => linkTargetsManifest(l, currentManifest));
  if (relevant.length === 0) return null;

  if (!acquireLock(siblingProjectRoot)) {
    console.error(`${LOG_PREFIX} backfill lock busy for ${siblingProjectRoot} — skipped`);
    return null;
  }

  try {
    const summary: BackfillSummary = {
      siblingProjectRoot,
      siblingServiceId: outbound.serviceId,
      resolved: 0,
      stale: 0,
      unchanged: 0,
    };

    // 1. Update outbound-links entries
    for (const link of relevant) {
      const prev = link.status;
      const next = rematchLink(link, currentManifest);
      link.targetServiceId = currentManifest.serviceId;
      link.status = next.status;
      link.remoteRef = next.remoteRef ?? (next.status === "resolved" ? link.remoteRef : undefined);
      if (next.status === "resolved" && link.remoteRef) {
        link.remoteDisplayName =
          resolveRemoteDisplayName(siblingProjectRoot, link.remoteRef.nodeId) ?? link.remoteDisplayName;
      }
      if (next.status === "resolved" && prev !== "resolved") summary.resolved++;
      else if (next.status === "stale" && prev !== "stale") summary.stale++;
      else summary.unchanged++;
    }
    saveOutboundLinks(siblingProjectRoot, outbound);

    // 2. Mirror the updates into the sibling's knowledge graph
    updateSiblingGraph(siblingProjectRoot, currentManifest, relevant);

    console.error(
      `${LOG_PREFIX} backfilled ${outbound.serviceId}: +${summary.resolved} resolved, +${summary.stale} stale`,
    );
    return summary;
  } finally {
    releaseLock(siblingProjectRoot);
  }
}

/** Sync community node/edge metadata in a sibling's graph with updated links. */
function updateSiblingGraph(
  siblingProjectRoot: string,
  currentManifest: CommunityManifest,
  updatedLinks: OutboundLink[],
): void {
  const graphPath = join(siblingProjectRoot, UA_DIR, GRAPH_FILE);
  if (!existsSync(graphPath)) return;

  let graph: KnowledgeGraph;
  try {
    graph = JSON.parse(readFileSync(graphPath, "utf8")) as KnowledgeGraph;
  } catch (err) {
    console.error(
      `${LOG_PREFIX} cannot parse sibling graph ${graphPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const linkByKey = new Map<string, OutboundLink>();
  for (const link of updatedLinks) {
    linkByKey.set(`${link.sourceNodeId}\u0000${link.matchHints.fullPath ?? ""}`, link);
  }

  const currentDomains = new Set(currentManifest.identity.domains.map((d) => d.toLowerCase()));
  let touchedEdges = 0;

  for (const edge of graph.edges) {
    if (edge.type !== "calls_community" || !edge.communityMeta) continue;
    const meta = edge.communityMeta;
    const targetsCurrent =
      meta.serviceId === currentManifest.serviceId ||
      (meta.matchHints?.domain && currentDomains.has(meta.matchHints.domain.toLowerCase()));
    if (!targetsCurrent) continue;

    const link = linkByKey.get(`${edge.source}\u0000${meta.matchHints?.fullPath ?? ""}`);
    if (!link) continue;

    meta.status = link.status;
    meta.serviceId = currentManifest.serviceId;
    meta.projectRef = currentManifest.projectPath;
    meta.remoteRef = link.remoteRef;
    meta.remoteDisplayName = link.remoteDisplayName;
    touchedEdges++;
  }

  // Migrate / refresh the portal node: a placeholder created from a bare
  // domain gets upgraded to the real serviceId-keyed node.
  const placeholderIds = new Set<string>([
    communityNodeId(currentManifest.serviceId),
    ...currentManifest.identity.domains.map((d) => communityNodeId(d)),
  ]);
  const portals = graph.nodes.filter((n) => n.type === "community" && placeholderIds.has(n.id));
  const canonicalId = communityNodeId(currentManifest.serviceId);

  if (portals.length > 0) {
    const anyResolved = updatedLinks.some((l) => l.status === "resolved");
    const keep = portals[0];
    const oldIds = portals.map((p) => p.id);

    keep.id = canonicalId;
    keep.name = currentManifest.displayName;
    keep.summary = `External service community "${currentManifest.serviceId}"`;
    keep.communityMeta = {
      ...(keep.communityMeta ?? { status: "pending" }),
      status: anyResolved ? "resolved" : keep.communityMeta?.status ?? "pending",
      serviceId: currentManifest.serviceId,
      domains: currentManifest.identity.domains,
      projectRef: currentManifest.projectPath,
    };
    // Drop duplicate portals and rewire their edges to the canonical node
    graph.nodes = graph.nodes.filter((n) => n.type !== "community" || !oldIds.slice(1).includes(n.id));
    for (const edge of graph.edges) {
      if (oldIds.includes(edge.target)) edge.target = canonicalId;
      if (oldIds.includes(edge.source)) edge.source = canonicalId;
    }
  }

  try {
    writeFileSync(graphPath, JSON.stringify(graph, null, 2), "utf8");
    console.error(`${LOG_PREFIX} updated sibling graph (${touchedEdges} edge(s) touched)`);
  } catch (err) {
    console.error(
      `${LOG_PREFIX} cannot write sibling graph ${graphPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Simple file lock (design D7 — defensive only) ───────────────────────────

function lockPath(projectRoot: string): string {
  return join(projectRoot, UA_DIR, LOCK_FILE);
}

function acquireLock(projectRoot: string): boolean {
  const p = lockPath(projectRoot);
  try {
    if (existsSync(p)) {
      const age = Date.now() - statSync(p).mtimeMs;
      if (age < LOCK_STALE_MS) return false; // genuinely held
      // Abandoned lock — take it over
    }
    writeFileSync(p, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
    return true;
  } catch {
    return false;
  }
}

function releaseLock(projectRoot: string): void {
  try {
    unlinkSync(lockPath(projectRoot));
  } catch {
    // Already gone — fine
  }
}
