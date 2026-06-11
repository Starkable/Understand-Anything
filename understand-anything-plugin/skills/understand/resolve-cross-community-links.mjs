#!/usr/bin/env node
/**
 * resolve-cross-community-links.mjs
 *
 * Cross-project community link resolution (runs after every /understand,
 * design D7). Zero LLM cost — fully deterministic.
 *
 * Steps:
 *   1. Resolve community identity (README frontmatter → fallbacks)
 *   2. Discover contextPaths (Spring/Express/Gin/FastAPI/NestJS + README)
 *   3. FORWARD: discover outbound HTTP calls in source, match them against
 *      sibling manifests, write community nodes/edges into the local graph,
 *      persist outbound-links.json
 *   4. Write community-manifest.json (this project's identity + routeCatalog)
 *   5. REVERSE: backfill every sibling project whose outbound links point at
 *      this project (placeholder → resolved, vanished routes → stale)
 *
 * Offline mode (no workspace): steps 3/5 are skipped except local discovery;
 * the manifest is still produced so siblings can link to us later.
 *
 * Usage:
 *   node resolve-cross-community-links.mjs <projectRoot>
 *
 * Output: human-readable report JSON on stdout; logs on stderr.
 * Exit 0 even when nothing matched (absence of cross-links is not an error).
 */
import { createRequire } from 'node:module';
import { dirname, resolve, join, extname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(__dirname, '../..');
const require = createRequire(resolve(pluginRoot, 'package.json'));

// ---------------------------------------------------------------------------
// Resolve @understand-anything/core (workspace link first, cache layout second)
// ---------------------------------------------------------------------------
let core;
try {
  core = await import(pathToFileURL(require.resolve('@understand-anything/core')).href);
} catch {
  core = await import(pathToFileURL(resolve(pluginRoot, 'packages/core/dist/index.js')).href);
}

const {
  resolveWorkspaceRoot,
  discoverProjects,
  resolveCommunityIdentity,
  discoverContextPaths,
  buildCommunityManifest,
  saveCommunityManifest,
  loadSiblingManifests,
  matchOutboundCall,
  applyCommunityLinks,
  stripCommunityArtifacts,
  toOutboundLinks,
  saveOutboundLinks,
  backfillSiblingProject,
  resolveRemoteDisplayName,
  extractUrlParts,
  composeOutboundPath,
  normalizeUrlPath,
} = core;

const LOG = (msg) => console.error(`[resolve-community] ${msg}`);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const projectRoot = process.argv[2] ? resolve(process.argv[2]) : null;
if (!projectRoot || !existsSync(projectRoot)) {
  console.error('Usage: node resolve-cross-community-links.mjs <projectRoot>');
  process.exit(1);
}

const UA_DIR = '.understand-anything';
const graphPath = join(projectRoot, UA_DIR, 'knowledge-graph.json');
if (!existsSync(graphPath)) {
  console.error(`No knowledge graph at ${graphPath} — run /understand first.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Outbound HTTP call discovery (task 4.1)
//
// Two deterministic signal sources:
//   A. Literal http(s) URLs in source code           → high confidence (0.85)
//   B. Config-declared baseUrl + code-level relative  → medium confidence (0.7)
//      path concatenation (`${orderUrl}/orders/1`, orderUrl + "/orders/1").
//      The variable name must fuzzily match a config key to avoid guessing.
//
// Anything that needs semantic understanding (Feign interfaces, dynamic URL
// builders) is intentionally LEFT OUT here — the file-analyzer LLM prompt
// covers those as semantic hints (task 5.2). False positives are costlier
// than false negatives (design risk table).
// ---------------------------------------------------------------------------

const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.java', '.kt', '.go', '.py', '.rb', '.php', '.cs',
]);
const CONFIG_EXTS = new Set(['.yml', '.yaml', '.properties', '.env', '.json', '.toml']);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', 'vendor', '__pycache__',
  '.understand-anything', 'coverage', '.idea', '.vscode',
]);
const MAX_FILES = 2000;
/** Domains that are never cross-service links. */
const IGNORED_DOMAINS = new Set(['localhost', '127.0.0.1', '0.0.0.0', 'example.com', 'www.w3.org', 'github.com', 'schemas.android.com', 'maven.apache.org']);

function* walkFiles(root, exts) {
  const stack = [root];
  let count = 0;
  while (stack.length > 0 && count < MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const abs = join(dir, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name) && !name.startsWith('.')) stack.push(abs);
      } else if (exts.has(extname(name).toLowerCase()) || (exts === CONFIG_EXTS && name.startsWith('.env'))) {
        count++;
        yield abs;
      }
    }
  }
}

/** Strip line/block comments well enough for URL scanning (not a full parser). */
function stripComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // /* ... */
    .replace(/^\s*\/\/.*$/gm, ' ')        // // ...
    .replace(/^\s*#.*$/gm, ' ');          // # ... (py/rb/yml)
}

/** Detect HTTP method from the ~60 chars preceding a call site. */
function sniffMethod(context) {
  const m = /\.\s*(get|post|put|delete|patch)\s*(?:\(|<|For)/i.exec(context) ||
    /\b(GET|POST|PUT|DELETE|PATCH)\b/.exec(context) ||
    /method\s*[:=]\s*['"](get|post|put|delete|patch)['"]/i.exec(context);
  return m ? m[1].toUpperCase() : undefined;
}

/** Normalize identifier/config-key for fuzzy correlation: orderUrl ↔ order.url */
function keyFingerprint(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Collect baseUrl declarations from config files: key → URL. */
function collectConfigBaseUrls(root) {
  const found = [];
  for (const file of walkFiles(root, CONFIG_EXTS)) {
    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    // key: https://host/path  |  key=https://host/path  |  "key": "https://…"
    const re = /([A-Za-z0-9_.\-"']{2,60})\s*[:=]\s*["']?(https?:\/\/[^\s"',;]+)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const key = m[1].replace(/["']/g, '');
      const url = m[2];
      const parts = extractUrlParts(url);
      if (!parts || IGNORED_DOMAINS.has(parts.domain)) continue;
      found.push({ key, url, file: relative(root, file) });
    }
  }
  LOG(`config scan: ${found.length} baseUrl candidate(s)`);
  return found;
}

/**
 * Map a source file to the best graph node id:
 *   endpoint node in that file → function node containing the line → file node.
 */
function buildFileNodeIndex(graph) {
  const byFile = new Map();
  for (const node of graph.nodes) {
    if (!node.filePath) continue;
    const key = node.filePath.replace(/\\/g, '/');
    const list = byFile.get(key) ?? [];
    list.push(node);
    byFile.set(key, list);
  }
  return byFile;
}

function nodeForCallSite(byFile, relPath, lineNo) {
  const nodes = byFile.get(relPath.replace(/\\/g, '/'));
  if (!nodes || nodes.length === 0) return null;
  const endpoint = nodes.find((n) => n.type === 'endpoint');
  if (endpoint) return endpoint.id;
  const fn = nodes.find(
    (n) => n.type === 'function' && Array.isArray(n.lineRange) &&
      n.lineRange[0] <= lineNo && lineNo <= n.lineRange[1],
  );
  if (fn) return fn.id;
  const file = nodes.find((n) => n.type === 'file');
  return file ? file.id : nodes[0].id;
}

function discoverOutboundSignals(root, graph, ownDomains) {
  const byFile = buildFileNodeIndex(graph);
  const configBaseUrls = collectConfigBaseUrls(root);
  const signals = [];
  const seen = new Set();
  const ownDomainSet = new Set(ownDomains.map((d) => d.toLowerCase()));

  const push = (signal) => {
    if (IGNORED_DOMAINS.has(signal.domain) || ownDomainSet.has(signal.domain)) return;
    const key = `${signal.sourceNodeId}\u0000${signal.method ?? ''}\u0000${signal.domain}${signal.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    signals.push(signal);
  };

  for (const file of walkFiles(root, SOURCE_EXTS)) {
    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    const relPath = relative(root, file);
    const stripped = stripComments(content);

    // A. Literal URLs
    const urlRe = /https?:\/\/[^\s"'`<>)\]}]+/g;
    let m;
    while ((m = urlRe.exec(stripped)) !== null) {
      const parts = extractUrlParts(m[0]);
      if (!parts) continue;
      const lineNo = stripped.slice(0, m.index).split('\n').length;
      const sourceNodeId = nodeForCallSite(byFile, relPath, lineNo);
      if (!sourceNodeId) continue;
      const context = stripped.slice(Math.max(0, m.index - 60), m.index);
      push({
        sourceNodeId,
        domain: parts.domain,
        method: sniffMethod(context),
        path: parts.path,
        description: `${sniffMethod(context) ?? 'HTTP'} ${m[0].split(/[?#]/)[0]}`,
        confidence: 0.85,
      });
    }

    // B. baseUrl variable + relative path concatenation
    //    `${orderUrl}/orders/1`  |  orderUrl + "/orders/1"
    const concatRe = /([A-Za-z_$][A-Za-z0-9_$]{1,40}(?:Url|URL|Host|Endpoint|Base|url|host|endpoint|base))\s*(?:\+\s*|\}\s*)?["'`](\/[A-Za-z0-9_\-./{}$]{1,120})["'`]/g;
    const tmplRe = /\$\{\s*([A-Za-z_$][A-Za-z0-9_$.]{1,60})\s*\}(\/[A-Za-z0-9_\-./{}$]{0,120})/g;
    for (const re of [concatRe, tmplRe]) {
      let c;
      while ((c = re.exec(stripped)) !== null) {
        const varName = c[1];
        const relPathLit = c[2];
        if (!relPathLit || relPathLit === '/') continue;
        // Correlate the variable with exactly one config baseUrl
        const fp = keyFingerprint(varName);
        const matches = configBaseUrls.filter(
          (b) => keyFingerprint(b.key).includes(fp) || fp.includes(keyFingerprint(b.key)),
        );
        const unique = [...new Set(matches.map((x) => x.url))];
        if (unique.length !== 1) continue; // 0 or >1 → cannot attribute safely
        const composed = composeOutboundPath(unique[0], relPathLit.replace(/\$\{[^}]*\}/g, '{param}'));
        if (!composed) continue;
        const lineNo = stripped.slice(0, c.index).split('\n').length;
        const sourceNodeId = nodeForCallSite(byFile, relPath, lineNo);
        if (!sourceNodeId) continue;
        const context = stripped.slice(Math.max(0, c.index - 60), c.index);
        push({
          sourceNodeId,
          domain: composed.domain,
          method: sniffMethod(context),
          path: composed.path,
          description: `${sniffMethod(context) ?? 'HTTP'} ${composed.domain}${composed.path} (via ${varName})`,
          confidence: 0.7,
        });
      }
    }
  }

  LOG(`outbound discovery: ${signals.length} unique signal(s)`);
  return signals;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const report = {
  scriptCompleted: true,
  serviceId: null,
  identitySource: null,
  workspaceMode: false,
  contextPaths: [],
  outboundSignals: 0,
  edges: { resolved: 0, pending: 0, ambiguous: 0 },
  ambiguousDetails: [],
  manifestRoutes: 0,
  backfilledSiblings: [],
  modifiedSiblingPaths: [],
};

// 1. Identity
const identity = resolveCommunityIdentity(projectRoot);
report.serviceId = identity.serviceId;
report.identitySource = identity.source;

// 2. contextPaths (auto-discovery + README merge happens in manifest builder)
const ctxDiscovery = discoverContextPaths(projectRoot);

// 3. Load graph
const graph = JSON.parse(readFileSync(graphPath, 'utf8'));

// 4. Workspace
const workspaceRoot = resolveWorkspaceRoot(projectRoot);
report.workspaceMode = workspaceRoot !== null;
const siblingRoots = workspaceRoot ? discoverProjects(workspaceRoot) : [];

// 5. FORWARD: outbound discovery + matching
const signals = discoverOutboundSignals(projectRoot, graph, identity.identity.domains);
report.outboundSignals = signals.length;

const index = loadSiblingManifests(siblingRoots, projectRoot);
const results = signals.map((signal) => {
  const r = matchOutboundCall(index, signal);
  // Enrich resolved hits with business display names from the sibling's domain graph
  if (r.status === 'resolved' && r.remoteRef) {
    const sibling = index.byServiceId.get(r.remoteRef.serviceId);
    if (sibling) {
      r.remoteDisplayName = resolveRemoteDisplayName(sibling.projectRoot, r.remoteRef.nodeId) ?? undefined;
    }
  }
  return r;
});

for (const r of results) {
  report.edges[r.status] = (report.edges[r.status] ?? 0) + 1;
  if (r.status === 'ambiguous') {
    report.ambiguousDetails.push({
      source: r.signal.sourceNodeId,
      call: `${r.signal.method ?? 'HTTP'} ${r.signal.domain}${r.signal.path}`,
      candidates: r.candidates.map((c) => c.serviceId),
    });
  }
}

// Re-apply idempotently: strip previous community artifacts, then add fresh ones
stripCommunityArtifacts(graph);
applyCommunityLinks(graph, results);
writeFileSync(graphPath, JSON.stringify(graph, null, 2), 'utf8');
LOG(`graph updated: ${graphPath}`);

saveOutboundLinks(projectRoot, toOutboundLinks(identity.serviceId, results));

// 6. Manifest (always produced — even offline, so siblings can link later)
const manifest = buildCommunityManifest({
  projectRoot,
  workspaceRoot,
  graph,
  resolvedIdentity: identity,
  discoveredContextPaths: ctxDiscovery.contextPaths,
});
saveCommunityManifest(projectRoot, manifest);
report.contextPaths = manifest.identity.contextPaths;
report.manifestRoutes = manifest.routeCatalog.length;

// 7. REVERSE: backfill siblings referencing this project (design D7/D8).
//    Never commits — modified paths are surfaced for the user to review.
if (workspaceRoot) {
  for (const siblingRoot of siblingRoots) {
    if (resolve(siblingRoot) === resolve(projectRoot)) continue;
    try {
      const summary = backfillSiblingProject(siblingRoot, manifest);
      if (summary) {
        report.backfilledSiblings.push({
          project: summary.siblingServiceId,
          resolved: summary.resolved,
          stale: summary.stale,
        });
        report.modifiedSiblingPaths.push(join(siblingRoot, UA_DIR));
      }
    } catch (err) {
      LOG(`backfill failed for ${siblingRoot}: ${err?.message ?? err}`);
    }
  }
}

console.log(JSON.stringify(report, null, 2));
