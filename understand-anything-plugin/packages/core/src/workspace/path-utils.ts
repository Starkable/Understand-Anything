/**
 * URL path normalization and matching for cross-community linking (design D5).
 *
 * Normalization rules:
 *   - collapse duplicate slashes, strip trailing slash
 *   - unify path parameters to "{param}"  ({id} / :id / <id> → {param})
 *   - optionally rewrite obviously-concrete id segments (numbers, UUIDs)
 *     to "{param}" so outbound literal URLs match route patterns
 *   - query strings are ignored (phase 1)
 */

const LOG_PREFIX = "[path-utils]";

/** Matches {anything}, :anything, <anything> as a whole path segment. */
const PARAM_SEGMENT = /^(\{[^/]*\}|:[^/]+|<[^/]+>)$/;

/** Concrete segments that are almost certainly ids: integers, UUIDs, long hex. */
const CONCRETE_ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;

export interface NormalizeOptions {
  /** Rewrite numeric/UUID segments to {param} (use on OUTBOUND concrete URLs) */
  collapseConcreteIds?: boolean;
}

/**
 * Normalize a URL path for matching.
 * Returns a path that always starts with "/" and never ends with one
 * (except the root path "/").
 */
export function normalizeUrlPath(rawPath: string, options: NormalizeOptions = {}): string {
  let path = rawPath.trim();

  // Drop query string and fragment (phase 1: ignored for matching)
  const queryIdx = path.search(/[?#]/);
  if (queryIdx !== -1) path = path.slice(0, queryIdx);

  // Ensure leading slash, collapse duplicate slashes
  if (!path.startsWith("/")) path = "/" + path;
  path = path.replace(/\/{2,}/g, "/");

  // Strip trailing slash (keep root "/")
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  // Per-segment parameter unification
  const segments = path.split("/").map((seg) => {
    if (seg === "") return seg;
    if (PARAM_SEGMENT.test(seg)) return "{param}";
    if (options.collapseConcreteIds && CONCRETE_ID_SEGMENT.test(seg)) return "{param}";
    return seg;
  });

  return segments.join("/") || "/";
}

/**
 * Join a contextPath and a controller-level path into the externally
 * visible fullPath:  "/order-api" + "/orders/{id}" → "/order-api/orders/{param}"
 */
export function joinContextPath(contextPath: string | undefined, controllerPath: string): string {
  const ctx = contextPath ? normalizeUrlPath(contextPath) : "";
  const ctrl = normalizeUrlPath(controllerPath);
  if (!ctx || ctx === "/") return ctrl;
  if (ctrl === "/") return ctx;
  return normalizeUrlPath(ctx + ctrl);
}

/**
 * Test whether two normalized path patterns match segment-by-segment.
 * "{param}" acts as a single-segment wildcard on EITHER side, so a concrete
 * outbound path "/orders/123" matches the catalog pattern "/orders/{param}".
 */
export function pathPatternsMatch(a: string, b: string): boolean {
  const segA = normalizeUrlPath(a).split("/");
  const segB = normalizeUrlPath(b).split("/");
  if (segA.length !== segB.length) return false;
  for (let i = 0; i < segA.length; i++) {
    if (segA[i] === segB[i]) continue;
    if (segA[i] === "{param}" || segB[i] === "{param}") continue;
    return false;
  }
  return true;
}

/** Test whether a normalized path starts with the given contextPath prefix. */
export function pathHasContextPrefix(path: string, contextPath: string): boolean {
  const p = normalizeUrlPath(path);
  const ctx = normalizeUrlPath(contextPath);
  if (ctx === "/") return true;
  return p === ctx || p.startsWith(ctx + "/");
}

export interface UrlParts {
  domain: string;
  /** Port retained for informational purposes; matching uses domain only */
  port?: string;
  path: string;
}

/**
 * Split an absolute http(s) URL into { domain, path }.
 * Returns null for non-http(s) or unparseable inputs (e.g. bare IPs are kept,
 * but template literals like `${HOST}/x` are rejected — cannot be matched).
 */
export function extractUrlParts(rawUrl: string): UrlParts | null {
  const trimmed = rawUrl.trim();
  const match = /^https?:\/\/([^/\s:?#]+)(?::(\d+))?([^?#\s]*)/i.exec(trimmed);
  if (!match) return null;
  const domain = match[1].toLowerCase();
  if (domain === "") return null;
  // Reject unresolved template placeholders (${HOST}, {host}, %s …) —
  // a templated hostname cannot be matched against manifest domains reliably
  if (/[${}%]/.test(domain)) return null;
  return {
    domain,
    port: match[2] || undefined,
    path: normalizeUrlPath(match[3] || "/", { collapseConcreteIds: true }),
  };
}

/**
 * Compose an outbound fullPath from a configured baseUrl (which may itself
 * carry a path prefix, e.g. "https://api.company.com/order-api") and a
 * code-level relative path ("/orders/123").
 */
export function composeOutboundPath(baseUrl: string, relativePath: string): UrlParts | null {
  const base = extractUrlParts(baseUrl);
  if (!base) {
    console.error(`${LOG_PREFIX} cannot parse baseUrl: ${baseUrl}`);
    return null;
  }
  const rel = normalizeUrlPath(relativePath, { collapseConcreteIds: true });
  const joined = base.path === "/" ? rel : normalizeUrlPath(base.path + rel);
  return { domain: base.domain, port: base.port, path: joined };
}
