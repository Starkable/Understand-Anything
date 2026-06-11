/**
 * Workspace discovery for cross-project community federation.
 *
 * A "workspace" is a parent directory containing multiple independently
 * cloned project repositories:
 *
 *   /workspace/
 *   ├── .understand-workspace.json   ← optional config (project list)
 *   ├── refund-service/
 *   ├── order-service/
 *   └── payment-service/
 *
 * Resolution order (see design D1):
 *   1. UNDERSTAND_WORKSPACE_ROOT environment variable
 *   2. Walk up from the project root looking for .understand-workspace.json
 *   3. Neither found → offline mode (single-project analysis only)
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import type { WorkspaceConfig } from "../types.js";

export const WORKSPACE_CONFIG_FILE = ".understand-workspace.json";
export const UA_DIR = ".understand-anything";

const LOG_PREFIX = "[workspace]";

/** Maximum parent directories to walk when searching for the workspace config. */
const MAX_WALK_UP_DEPTH = 6;

/**
 * Resolve the workspace root for a given project.
 * Returns null when no workspace is configured (offline mode).
 */
export function resolveWorkspaceRoot(projectRoot: string): string | null {
  // 1. Environment variable wins
  const envRoot = process.env.UNDERSTAND_WORKSPACE_ROOT;
  if (envRoot && envRoot.trim() !== "") {
    const resolved = resolve(envRoot.trim());
    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      console.error(`${LOG_PREFIX} workspace root from env: ${resolved}`);
      return resolved;
    }
    console.error(
      `${LOG_PREFIX} UNDERSTAND_WORKSPACE_ROOT points to a missing directory: ${resolved} — ignoring`,
    );
  }

  // 2. Walk up from the project root looking for the config file
  let current = resolve(projectRoot);
  for (let depth = 0; depth < MAX_WALK_UP_DEPTH; depth++) {
    const parent = dirname(current);
    if (parent === current) break; // filesystem root reached
    if (existsSync(join(parent, WORKSPACE_CONFIG_FILE))) {
      console.error(`${LOG_PREFIX} workspace root from config file: ${parent}`);
      return parent;
    }
    current = parent;
  }

  // 3. Offline mode
  console.error(`${LOG_PREFIX} no workspace configured — offline mode`);
  return null;
}

/**
 * Load .understand-workspace.json from the workspace root.
 * Returns a default config when the file is absent or unreadable
 * (absent file is legitimate when the root came from the env variable).
 */
export function loadWorkspaceConfig(workspaceRoot: string): WorkspaceConfig {
  const configPath = join(workspaceRoot, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) {
    return { version: "1" };
  }
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Partial<WorkspaceConfig>;
    return {
      version: typeof raw.version === "string" ? raw.version : "1",
      projects: Array.isArray(raw.projects)
        ? raw.projects.filter((p): p is string => typeof p === "string" && p.trim() !== "")
        : undefined,
    };
  } catch (err) {
    console.error(
      `${LOG_PREFIX} failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)} — using defaults`,
    );
    return { version: "1" };
  }
}

/**
 * Discover analyzable project directories inside the workspace.
 *
 * - When config.projects is given, resolve those entries (skipping missing dirs).
 * - Otherwise scan immediate subdirectories that contain a `.understand-anything/`
 *   directory (i.e. projects that have been analyzed at least once).
 *
 * Returns absolute paths, sorted for determinism.
 */
export function discoverProjects(
  workspaceRoot: string,
  config?: WorkspaceConfig,
): string[] {
  const cfg = config ?? loadWorkspaceConfig(workspaceRoot);
  const found: string[] = [];

  if (cfg.projects && cfg.projects.length > 0) {
    for (const entry of cfg.projects) {
      const abs = isAbsolute(entry) ? entry : join(workspaceRoot, entry);
      if (existsSync(abs) && statSync(abs).isDirectory()) {
        found.push(resolve(abs));
      } else {
        console.error(`${LOG_PREFIX} configured project missing on disk: ${abs} — skipped`);
      }
    }
  } else {
    // Auto-scan: any immediate subdirectory with a .understand-anything/ dir
    let entries: string[] = [];
    try {
      entries = readdirSync(workspaceRoot);
    } catch (err) {
      console.error(
        `${LOG_PREFIX} cannot read workspace root ${workspaceRoot}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
    for (const name of entries) {
      const abs = join(workspaceRoot, name);
      try {
        if (statSync(abs).isDirectory() && existsSync(join(abs, UA_DIR))) {
          found.push(resolve(abs));
        }
      } catch {
        // Unreadable entry (permissions, broken symlink) — skip silently
      }
    }
  }

  found.sort((a, b) => a.localeCompare(b));
  console.error(`${LOG_PREFIX} discovered ${found.length} project(s) in workspace`);
  return found;
}
