/**
 * contextPath auto-discovery across stacks (design D5).
 *
 * Many services expose routes under a configured prefix that does NOT appear
 * in controller annotations. Matching outbound calls against bare controller
 * paths fails under shared domains, so the manifest must record fullPath =
 * contextPath + controllerPath.
 *
 * Sources, by stack:
 *   P0  Spring Boot   server.servlet.context-path (yml/properties)
 *   P0  Express       app.use('/prefix', router)
 *   P1  Gin           r.Group("/api")        (top-level groups only)
 *   P1  FastAPI       APIRouter(prefix="/api") / include_router(..., prefix=)
 *   P1  NestJS        app.setGlobalPrefix('api')
 *   兜底 README        understand-community.contextPaths
 *
 * Discovery is best-effort: failures degrade to README-declared contextPaths
 * (handled by the caller), never to a hard error.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { normalizeUrlPath } from "./path-utils.js";

const LOG_PREFIX = "[context-path]";

/** Files scanned for Spring Boot configuration. */
const SPRING_CONFIG_CANDIDATES = [
  "src/main/resources/application.yml",
  "src/main/resources/application.yaml",
  "src/main/resources/application.properties",
  "application.yml",
  "application.yaml",
  "application.properties",
];

/** Max source files scanned per stack heuristic (keeps discovery cheap). */
const MAX_SOURCE_SCAN_FILES = 200;

export interface ContextPathDiscovery {
  contextPaths: string[];
  /** Which heuristic produced each path (for the analysis report) */
  sources: Array<{ contextPath: string; source: string }>;
}

function dedupe(paths: string[]): string[] {
  return [...new Set(paths.map((p) => normalizeUrlPath(p)))].filter((p) => p !== "/");
}

// ── Spring Boot ──────────────────────────────────────────────────────────────

function extractSpringContextPaths(projectRoot: string): string[] {
  const found: string[] = [];
  for (const candidate of SPRING_CONFIG_CANDIDATES) {
    const p = join(projectRoot, candidate);
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, "utf8");
      if (candidate.endsWith(".properties")) {
        // server.servlet.context-path=/order-api  (also legacy server.context-path)
        const m = /^\s*server\.(?:servlet\.)?context-path\s*[=:]\s*(\S+)/m.exec(content);
        if (m) found.push(m[1]);
      } else {
        // YAML may contain multiple documents (--- separated profiles)
        for (const doc of content.split(/^---\s*$/m)) {
          try {
            const data = parseYaml(doc) as Record<string, any> | null;
            const ctx =
              data?.server?.servlet?.["context-path"] ??
              data?.server?.["context-path"] ??
              data?.["server.servlet.context-path"];
            if (typeof ctx === "string" && ctx.trim() !== "") found.push(ctx.trim());
          } catch {
            // One malformed profile document must not kill discovery
          }
        }
      }
    } catch {
      // Unreadable config — try the next candidate
    }
  }
  return found;
}

// ── Generic source scanning helpers ──────────────────────────────────────────

function* walkSourceFiles(
  projectRoot: string,
  extensions: string[],
  maxFiles: number,
): Generator<string> {
  const skipDirs = new Set(["node_modules", ".git", "dist", "build", "target", "vendor", ".understand-anything"]);
  const stack = [projectRoot];
  let yielded = 0;
  while (stack.length > 0 && yielded < maxFiles) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (yielded >= maxFiles) return;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!skipDirs.has(name) && !name.startsWith(".")) stack.push(abs);
      } else if (extensions.includes(extname(name))) {
        yielded++;
        yield abs;
      }
    }
  }
}

function scanFilesForPatterns(
  projectRoot: string,
  extensions: string[],
  patterns: Array<{ regex: RegExp; source: string }>,
): Array<{ contextPath: string; source: string }> {
  const results: Array<{ contextPath: string; source: string }> = [];
  for (const file of walkSourceFiles(projectRoot, extensions, MAX_SOURCE_SCAN_FILES)) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const { regex, source } of patterns) {
      // Use a fresh regex per file (global flag keeps lastIndex state)
      const re = new RegExp(regex.source, regex.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const path = m[1];
        if (path && path.startsWith("/") && path.length > 1) {
          results.push({ contextPath: path, source });
        } else if (path && !path.startsWith("/") && source === "nestjs-global-prefix") {
          // setGlobalPrefix('api') — prefix without leading slash is idiomatic
          results.push({ contextPath: "/" + path, source });
        }
      }
    }
  }
  return results;
}

// ── Stack-specific extractors ────────────────────────────────────────────────

function extractExpressPrefixes(projectRoot: string): Array<{ contextPath: string; source: string }> {
  // app.use('/api', router) — only string-literal first arg followed by an
  // identifier (router reference), to avoid matching middleware-only use().
  return scanFilesForPatterns(projectRoot, [".js", ".mjs", ".cjs", ".ts"], [
    {
      regex: /\bapp\.use\(\s*['"`](\/[^'"`]+)['"`]\s*,\s*[A-Za-z_$]/g,
      source: "express-app-use",
    },
  ]);
}

function extractGinPrefixes(projectRoot: string): Array<{ contextPath: string; source: string }> {
  // r.Group("/api") — top-level route groups
  return scanFilesForPatterns(projectRoot, [".go"], [
    { regex: /\.Group\(\s*"(\/[^"]+)"/g, source: "gin-group" },
  ]);
}

function extractFastApiPrefixes(projectRoot: string): Array<{ contextPath: string; source: string }> {
  return scanFilesForPatterns(projectRoot, [".py"], [
    { regex: /APIRouter\([^)]*prefix\s*=\s*['"](\/[^'"]+)['"]/g, source: "fastapi-router-prefix" },
    { regex: /include_router\([^)]*prefix\s*=\s*['"](\/[^'"]+)['"]/g, source: "fastapi-include-router" },
  ]);
}

function extractNestPrefixes(projectRoot: string): Array<{ contextPath: string; source: string }> {
  return scanFilesForPatterns(projectRoot, [".ts"], [
    { regex: /setGlobalPrefix\(\s*['"`]\/?([^'"`]+)['"`]/g, source: "nestjs-global-prefix" },
  ]);
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Discover contextPaths for a project across all supported stacks.
 * README-declared contextPaths should be merged by the caller (they are the
 * authoritative fallback, see design D5).
 */
export function discoverContextPaths(projectRoot: string): ContextPathDiscovery {
  const sources: Array<{ contextPath: string; source: string }> = [];

  for (const ctx of extractSpringContextPaths(projectRoot)) {
    sources.push({ contextPath: ctx, source: "spring-context-path" });
  }
  sources.push(...extractExpressPrefixes(projectRoot));
  sources.push(...extractGinPrefixes(projectRoot));
  sources.push(...extractFastApiPrefixes(projectRoot));
  sources.push(...extractNestPrefixes(projectRoot));

  const contextPaths = dedupe(sources.map((s) => s.contextPath));
  console.error(
    `${LOG_PREFIX} discovered ${contextPaths.length} contextPath(s): ${contextPaths.join(", ") || "(none)"}`,
  );
  return { contextPaths, sources };
}
