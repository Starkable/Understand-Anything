/**
 * Cross-project community federation (workspace) module.
 *
 * Node-only — pulls in node:fs / node:path. The dashboard must NOT import
 * this module; browser-safe data shapes live in ../types.ts.
 */
export {
  resolveWorkspaceRoot,
  loadWorkspaceConfig,
  discoverProjects,
  WORKSPACE_CONFIG_FILE,
} from "./workspace.js";
export {
  parseReadmeFrontmatter,
  resolveCommunityIdentity,
  writeIdentitySidecar,
  type ResolvedCommunityIdentity,
  type IdentitySource,
} from "./identity.js";
export {
  normalizeUrlPath,
  joinContextPath,
  pathPatternsMatch,
  pathHasContextPrefix,
  extractUrlParts,
  composeOutboundPath,
  type UrlParts,
  type NormalizeOptions,
} from "./path-utils.js";
export {
  discoverContextPaths,
  type ContextPathDiscovery,
} from "./context-path.js";
export {
  buildRouteCatalog,
  buildCommunityManifest,
  saveCommunityManifest,
  loadCommunityManifest,
  loadSiblingManifests,
  parseEndpointSignature,
  saveOutboundLinks,
  loadOutboundLinks,
  MANIFEST_FILE,
  OUTBOUND_LINKS_FILE,
  type ManifestIndex,
  type SiblingManifest,
} from "./manifest.js";
export {
  matchOutboundCall,
  applyCommunityLinks,
  stripCommunityArtifacts,
  toOutboundLinks,
  backfillSiblingProject,
  resolveRemoteDisplayName,
  communityNodeId,
  type OutboundCallSignal,
  type MatchResult,
  type BackfillSummary,
} from "./linker.js";
export {
  buildFederationGraph,
  type FederationGraph,
} from "./federation.js";
