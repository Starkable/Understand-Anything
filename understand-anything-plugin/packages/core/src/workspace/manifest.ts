/**
 * community-manifest.json generation and the distributed sibling index
 * (design D3). No centralized registry: each project writes its own manifest
 * after analysis; analyzers read sibling manifests on demand and build an
 * in-memory lookup table that is discarded when analysis finishes.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename, relative } from "node:path";
import type {
  KnowledgeGraph,
  CommunityManifest,
  RouteCatalogEntry,
  OutboundLinksFile,
} from "../types.js";
import type { ResolvedCommunityIdentity } from "./identity.js";
import { normalizeUrlPath, joinContextPath, pathHasContextPrefix } from "./path-utils.js";

const LOG_PREFIX = "[community-manifest]";
const UA_DIR = ".understand-anything";
export const MANIFEST_FILE = "community-manifest.json";
export const OUTBOUND_LINKS_FILE = "outbound-links.json";
const GRAPH_FILE = "knowledge-graph.json";
const DOMAIN_GRAPH_FILE = "domain-graph.json";

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];

/**
 * Parse "GET /orders/{id}"-style strings (endpoint node names / summaries)
 * into method + path. Tolerant: method is optional, path required.
 */
export function parseEndpointSignature(text: string): { method?: string; path: string } | null {
  const methodMatch = new RegExp(`\\b(${HTTP_METHODS.join("|")})\\b`, "i").exec(text);
  const pathMatch = /(\/[A-Za-z0-9_\-./{}:<>]*)/.exec(text);
  if (!pathMatch) return null;
  const path = pathMatch[1];
  // A lone "/" with no method context is too weak a signal
  if (path === "/" && !methodMatch) return null;
  return {
    method: methodMatch ? methodMatch[1].toUpperCase() : undefined,
    path,
  };
}

/**
 * Build the routeCatalog from a structural graph's endpoint nodes.
 *
 * fullPath synthesis per design D5:
 *   - controllerPath already includes a known contextPath → use as-is
 *   - exactly one contextPath known → prepend it
 *   - several contextPaths → emit one entry per candidate (match-time
 *     prefix filtering keeps this safe; ambiguity is surfaced, not guessed)
 */
export function buildRouteCatalog(
  graph: KnowledgeGraph,
  contextPaths: string[],
): RouteCatalogEntry[] {
  const catalog: RouteCatalogEntry[] = [];
  const normalizedCtx = contextPaths.map((c) => normalizeUrlPath(c)).filter((c) => c !== "/");

  for (const node of graph.nodes) {
    if (node.type !== "endpoint") continue;
    // Endpoint metadata lives in the node name (preferred) or summary
    const sig = parseEndpointSignature(node.name) ?? parseEndpointSignature(node.summary);
    if (!sig) {
      console.error(`${LOG_PREFIX} endpoint node without parseable path: ${node.id} — skipped`);
      continue;
    }
    const controllerPath = normalizeUrlPath(sig.path);

    const alreadyPrefixed = normalizedCtx.find((ctx) => pathHasContextPrefix(controllerPath, ctx));
    if (alreadyPrefixed) {
      catalog.push({
        nodeId: node.id,
        method: sig.method,
        controllerPath,
        fullPath: controllerPath,
        contextPath: alreadyPrefixed,
      });
    } else if (normalizedCtx.length === 0) {
      catalog.push({ nodeId: node.id, method: sig.method, controllerPath, fullPath: controllerPath });
    } else {
      for (const ctx of normalizedCtx) {
        catalog.push({
          nodeId: node.id,
          method: sig.method,
          controllerPath,
          fullPath: joinContextPath(ctx, controllerPath),
          contextPath: ctx,
        });
      }
    }
  }

  console.error(`${LOG_PREFIX} built routeCatalog with ${catalog.length} entries`);
  return catalog;
}

/** Assemble the full manifest object for a project. */
export function buildCommunityManifest(args: {
  projectRoot: string;
  workspaceRoot?: string | null;
  graph: KnowledgeGraph;
  resolvedIdentity: ResolvedCommunityIdentity;
  /** Auto-discovered contextPaths (merged with README-declared ones) */
  discoveredContextPaths?: string[];
}): CommunityManifest {
  const { projectRoot, workspaceRoot, graph, resolvedIdentity } = args;

  // README-declared contextPaths are authoritative; auto-discovered ones are merged in.
  const contextPaths = [
    ...new Set(
      [...resolvedIdentity.identity.contextPaths, ...(args.discoveredContextPaths ?? [])].map((c) =>
        normalizeUrlPath(c),
      ),
    ),
  ].filter((c) => c !== "/");

  const manifest: CommunityManifest = {
    serviceId: resolvedIdentity.serviceId,
    displayName: resolvedIdentity.displayName,
    projectPath: workspaceRoot ? relative(workspaceRoot, projectRoot) : basename(projectRoot),
    analyzedAt: new Date().toISOString(),
    identity: {
      domains: resolvedIdentity.identity.domains,
      aliases: resolvedIdentity.identity.aliases,
      contextPaths,
    },
    routeCatalog: buildRouteCatalog(graph, contextPaths),
    graphRefs: {
      structural: `${UA_DIR}/${GRAPH_FILE}`,
      ...(existsSync(join(projectRoot, UA_DIR, DOMAIN_GRAPH_FILE))
        ? { domain: `${UA_DIR}/${DOMAIN_GRAPH_FILE}` }
        : {}),
    },
  };
  return manifest;
}

export function saveCommunityManifest(projectRoot: string, manifest: CommunityManifest): void {
  const dir = join(projectRoot, UA_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), "utf8");
  console.error(
    `${LOG_PREFIX} saved manifest for "${manifest.serviceId}" (${manifest.routeCatalog.length} routes, ${manifest.identity.domains.length} domains)`,
  );
}

export function loadCommunityManifest(projectRoot: string): CommunityManifest | null {
  const p = join(projectRoot, UA_DIR, MANIFEST_FILE);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as CommunityManifest;
    if (typeof data.serviceId !== "string" || !Array.isArray(data.routeCatalog)) {
      console.error(`${LOG_PREFIX} malformed manifest at ${p} — ignored`);
      return null;
    }
    return data;
  } catch (err) {
    console.error(
      `${LOG_PREFIX} failed to read manifest at ${p}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ── Distributed sibling index (design D3) ────────────────────────────────────

export interface SiblingManifest {
  manifest: CommunityManifest;
  /** Absolute path of the sibling project on disk */
  projectRoot: string;
}

/** In-memory lookup table over sibling manifests. Discard after analysis. */
export interface ManifestIndex {
  /** domain → manifests claiming that domain (shared domains → multiple) */
  byDomain: Map<string, SiblingManifest[]>;
  /** alias (lowercased) → manifest */
  byAlias: Map<string, SiblingManifest>;
  byServiceId: Map<string, SiblingManifest>;
  all: SiblingManifest[];
}

/**
 * Read sibling manifests (excluding the current project) and build the
 * in-memory index. Projects without a manifest are silently skipped —
 * they become placeholder communities at match time.
 */
export function loadSiblingManifests(
  projectRoots: string[],
  excludeProjectRoot: string,
): ManifestIndex {
  const index: ManifestIndex = {
    byDomain: new Map(),
    byAlias: new Map(),
    byServiceId: new Map(),
    all: [],
  };

  for (const root of projectRoots) {
    if (samePath(root, excludeProjectRoot)) continue;
    const manifest = loadCommunityManifest(root);
    if (!manifest) continue;

    const entry: SiblingManifest = { manifest, projectRoot: root };
    index.all.push(entry);
    index.byServiceId.set(manifest.serviceId, entry);

    for (const domain of manifest.identity.domains) {
      const key = domain.toLowerCase();
      const list = index.byDomain.get(key) ?? [];
      list.push(entry);
      index.byDomain.set(key, list);
    }
    for (const alias of manifest.identity.aliases) {
      index.byAlias.set(alias.toLowerCase(), entry);
    }
  }

  console.error(
    `${LOG_PREFIX} sibling index: ${index.all.length} manifest(s), ${index.byDomain.size} domain(s)`,
  );
  return index;
}

function samePath(a: string, b: string): boolean {
  // Windows-tolerant comparison (case-insensitive, separator-normalized)
  const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
  return norm(a) === norm(b);
}

// ── outbound-links.json IO (task 4.4) ────────────────────────────────────────

export function saveOutboundLinks(projectRoot: string, links: OutboundLinksFile): void {
  const dir = join(projectRoot, UA_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, OUTBOUND_LINKS_FILE), JSON.stringify(links, null, 2), "utf8");
  console.error(`${LOG_PREFIX} saved ${links.links.length} outbound link(s) for "${links.serviceId}"`);
}

export function loadOutboundLinks(projectRoot: string): OutboundLinksFile | null {
  const p = join(projectRoot, UA_DIR, OUTBOUND_LINKS_FILE);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as OutboundLinksFile;
    if (typeof data.serviceId !== "string" || !Array.isArray(data.links)) {
      console.error(`${LOG_PREFIX} malformed outbound-links at ${p} — ignored`);
      return null;
    }
    return data;
  } catch (err) {
    console.error(
      `${LOG_PREFIX} failed to read outbound-links at ${p}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
