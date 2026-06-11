/**
 * Community identity resolution (design D2).
 *
 * Authoritative source: `understand-community` YAML frontmatter at the top
 * of the project's README. Fallback chain for serviceId:
 *
 *   README frontmatter → package.json name → repository directory name
 *
 * The resolver NEVER modifies the README. When a fallback is used, the
 * inferred identity is written to `.understand-anything/community-identity.json`
 * (sidecar) so the user can copy it into the README later.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { parse as parseYaml } from "yaml";
import type { CommunityIdentity } from "../types.js";

const LOG_PREFIX = "[community-identity]";
const README_CANDIDATES = ["README.md", "readme.md", "README.rst", "README"];
const SIDECAR_FILE = "community-identity.json";
const UA_DIR = ".understand-anything";

/** Where the resolved serviceId came from — affects user messaging. */
export type IdentitySource = "readme" | "package-json" | "directory-name";

export interface ResolvedCommunityIdentity {
  serviceId: string;
  displayName: string;
  identity: CommunityIdentity;
  source: IdentitySource;
  /** True when the README lacked frontmatter and the user should add it */
  needsReadmeUpdate: boolean;
}

interface FrontmatterCommunity {
  serviceId?: unknown;
  displayName?: unknown;
  domains?: unknown;
  aliases?: unknown;
  contextPaths?: unknown;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
}

/**
 * Extract the `understand-community` block from README frontmatter.
 * Returns null when no frontmatter or no understand-community key exists.
 */
export function parseReadmeFrontmatter(content: string): FrontmatterCommunity | null {
  // Frontmatter must start at the very beginning: ---\n ... \n---
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return null;
  try {
    const data = parseYaml(match[1]) as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return null;
    const block = data["understand-community"];
    if (!block || typeof block !== "object") return null;
    return block as FrontmatterCommunity;
  } catch (err) {
    console.error(
      `${LOG_PREFIX} failed to parse README frontmatter: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function readReadme(projectRoot: string): string | null {
  for (const candidate of README_CANDIDATES) {
    const p = join(projectRoot, candidate);
    if (existsSync(p)) {
      try {
        return readFileSync(p, "utf8");
      } catch {
        // Unreadable — try next candidate
      }
    }
  }
  return null;
}

function readPackageJsonName(projectRoot: string): string | null {
  const p = join(projectRoot, "package.json");
  if (!existsSync(p)) return null;
  try {
    const pkg = JSON.parse(readFileSync(p, "utf8")) as { name?: unknown };
    if (typeof pkg.name === "string" && pkg.name.trim() !== "") {
      // Strip npm scope: @org/name → name
      return pkg.name.replace(/^@[^/]+\//, "");
    }
  } catch {
    // Malformed package.json — fall through
  }
  return null;
}

/**
 * Resolve the community identity for a project.
 *
 * Writes the sidecar `.understand-anything/community-identity.json` whenever
 * the identity was inferred (not declared in README), so the user can later
 * promote it into README frontmatter. The README itself is never touched.
 */
export function resolveCommunityIdentity(projectRoot: string): ResolvedCommunityIdentity {
  const readme = readReadme(projectRoot);
  const fm = readme ? parseReadmeFrontmatter(readme) : null;

  let serviceId: string | null = null;
  let source: IdentitySource = "readme";

  if (fm && typeof fm.serviceId === "string" && fm.serviceId.trim() !== "") {
    serviceId = fm.serviceId.trim();
  } else {
    const pkgName = readPackageJsonName(projectRoot);
    if (pkgName) {
      serviceId = pkgName;
      source = "package-json";
    } else {
      serviceId = basename(projectRoot);
      source = "directory-name";
    }
  }

  const displayName =
    fm && typeof fm.displayName === "string" && fm.displayName.trim() !== ""
      ? fm.displayName.trim()
      : serviceId;

  const identity: CommunityIdentity = {
    domains: asStringArray(fm?.domains),
    aliases: asStringArray(fm?.aliases),
    contextPaths: asStringArray(fm?.contextPaths),
  };

  const resolved: ResolvedCommunityIdentity = {
    serviceId,
    displayName,
    identity,
    source,
    needsReadmeUpdate: source !== "readme",
  };

  console.error(
    `${LOG_PREFIX} resolved serviceId="${serviceId}" (source=${source}, domains=${identity.domains.length})`,
  );

  // Persist the sidecar when identity was inferred so the user can adopt it.
  if (resolved.needsReadmeUpdate) {
    writeIdentitySidecar(projectRoot, resolved);
  }

  return resolved;
}

/** Write `.understand-anything/community-identity.json` (inferred identity record). */
export function writeIdentitySidecar(
  projectRoot: string,
  resolved: ResolvedCommunityIdentity,
): void {
  const dir = join(projectRoot, UA_DIR);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const sidecar = {
      serviceId: resolved.serviceId,
      displayName: resolved.displayName,
      source: resolved.source,
      identity: resolved.identity,
      note: "Inferred by the analyzer. Add an `understand-community` frontmatter block to README.md to make this authoritative.",
      generatedAt: new Date().toISOString(),
    };
    writeFileSync(join(dir, SIDECAR_FILE), JSON.stringify(sidecar, null, 2), "utf8");
    console.error(`${LOG_PREFIX} wrote sidecar ${SIDECAR_FILE} (source=${resolved.source})`);
  } catch (err) {
    console.error(
      `${LOG_PREFIX} failed to write identity sidecar: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
