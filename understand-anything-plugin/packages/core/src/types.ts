// Node types (22 total: 5 code + 8 non-code + 3 domain + 5 knowledge + 1 community)
// NOTE: "community" = cross-project service community portal (NOT the in-project
// business "domain" node, and NOT the Louvain file-clustering "community" used
// internally by compute-batches).
export type NodeType =
  | "file" | "function" | "class" | "module" | "concept"
  | "config" | "document" | "service" | "table" | "endpoint"
  | "pipeline" | "schema" | "resource"
  | "domain" | "flow" | "step"
  | "article" | "entity" | "topic" | "claim" | "source"
  | "community";

// Edge types (36 total in 9 categories: Structural, Behavioral, Data flow, Dependencies, Semantic, Infrastructure/Schema, Domain, Knowledge, Community)
export type EdgeType =
  | "imports" | "exports" | "contains" | "inherits" | "implements"  // Structural
  | "calls" | "subscribes" | "publishes" | "middleware"              // Behavioral
  | "reads_from" | "writes_to" | "transforms" | "validates"         // Data flow
  | "depends_on" | "tested_by" | "configures"                       // Dependencies
  | "related" | "similar_to"                                         // Semantic
  | "deploys" | "serves" | "provisions" | "triggers"                // Infrastructure
  | "migrates" | "documents" | "routes" | "defines_schema"          // Schema/Data
  | "contains_flow" | "flow_step" | "cross_domain"                  // Domain
  | "cites" | "contradicts" | "builds_on" | "exemplifies" | "categorized_under" | "authored_by" // Knowledge
  | "calls_community";                                               // Community (cross-project)

// Optional knowledge metadata for article/entity/topic/claim/source nodes
export interface KnowledgeMeta {
  wikilinks?: string[];
  backlinks?: string[];
  category?: string;
  content?: string;
}

// Optional domain metadata for domain/flow/step nodes
export interface DomainMeta {
  entities?: string[];
  businessRules?: string[];
  crossDomainInteractions?: string[];
  entryPoint?: string;
  entryType?: "http" | "cli" | "event" | "cron" | "manual";
}

// ── Cross-project community federation types ────────────────────────────────

/**
 * Globally-qualified reference to a node in ANOTHER project's graph.
 * A bare nodeId is NOT unique across projects (two services can both have
 * "endpoint:src/controller:handler"), so cross-community edges must always
 * carry the full triple.
 */
export interface RemoteNodeRef {
  serviceId: string;
  graphKind: "structural" | "domain";
  nodeId: string;
}

/**
 * Match signals captured at discovery time. Kept on pending/ambiguous edges
 * so a later backfill pass can resolve them once the target community's
 * manifest becomes available.
 */
export interface MatchHints {
  domain?: string;
  method?: string;
  fullPath?: string;
  contextPathHint?: string;
}

/**
 * Community metadata carried by `community` nodes and `calls_community` edges.
 *
 * Status lifecycle:
 *   pending   — target community not analyzed yet (placeholder)
 *   resolved  — matched to a concrete remote node
 *   ambiguous — multiple candidates, no auto-pick (policy A)
 *   stale     — previously resolved but target routeCatalog changed
 */
export interface CommunityMeta {
  status: "pending" | "resolved" | "ambiguous" | "stale";
  serviceId?: string;
  domains?: string[];
  /** Workspace-relative path to the sibling project (filled when resolved) */
  projectRef?: string;
  remoteRef?: RemoteNodeRef;
  /** Display name preferring the remote flow/step name over endpoint id */
  remoteDisplayName?: string;
  matchHints?: MatchHints;
  /** 0-1 match confidence */
  confidence?: number;
}

/** One inbound HTTP route exposed by a community (entry in the manifest). */
export interface RouteCatalogEntry {
  /** Structural-graph endpoint node id implementing this route */
  nodeId: string;
  method?: string;
  /** Controller-level path as written in code, e.g. "/orders/{id}" */
  controllerPath: string;
  /** contextPath + controllerPath, normalized — the externally visible path */
  fullPath: string;
  contextPath?: string;
}

/** Community identity declared in README frontmatter (plus auto-discovered parts). */
export interface CommunityIdentity {
  domains: string[];
  aliases: string[];
  contextPaths: string[];
}

/**
 * community-manifest.json — written to each project's .understand-anything/
 * after analysis; read by sibling projects to build the distributed index.
 */
export interface CommunityManifest {
  serviceId: string;
  displayName: string;
  /** Workspace-relative project path (informational) */
  projectPath: string;
  analyzedAt: string;
  identity: CommunityIdentity;
  routeCatalog: RouteCatalogEntry[];
  graphRefs: {
    structural: string;
    domain?: string;
  };
}

/**
 * One outbound cross-community reference recorded in outbound-links.json.
 * Sibling projects scan these files during backfill.
 */
export interface OutboundLink {
  /** Node id in THIS project's graph that makes the call */
  sourceNodeId: string;
  /** Resolved or guessed target serviceId (absent when fully unknown) */
  targetServiceId?: string;
  status: CommunityMeta["status"];
  matchHints: MatchHints;
  remoteRef?: RemoteNodeRef;
  remoteDisplayName?: string;
  confidence?: number;
}

/** outbound-links.json file shape. */
export interface OutboundLinksFile {
  serviceId: string;
  generatedAt: string;
  links: OutboundLink[];
}

/** .understand-workspace.json at the workspace root. */
export interface WorkspaceConfig {
  version: string;
  /** Relative project dirs; when omitted, all subdirs with .understand-anything/ are scanned */
  projects?: string[];
}

// GraphNode with 22 types: 5 code + 8 non-code + 3 domain + 5 knowledge + 1 community
export interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  filePath?: string;
  lineRange?: [number, number];
  summary: string;
  tags: string[];
  complexity: "simple" | "moderate" | "complex";
  languageNotes?: string;
  domainMeta?: DomainMeta;
  knowledgeMeta?: KnowledgeMeta;
  communityMeta?: CommunityMeta;
}

// GraphEdge with rich relationship modeling
export interface GraphEdge {
  source: string;
  target: string;
  type: EdgeType;
  direction: "forward" | "backward" | "bidirectional";
  description?: string;
  weight: number; // 0-1
  /** Present on calls_community edges (cross-project links) */
  communityMeta?: CommunityMeta;
}

// Layer (logical grouping)
export interface Layer {
  id: string;
  name: string;
  description: string;
  nodeIds: string[];
}

// TourStep (for learn mode)
export interface TourStep {
  order: number;
  title: string;
  description: string;
  nodeIds: string[];
  languageLesson?: string;
}

// ProjectMeta
export interface ProjectMeta {
  name: string;
  languages: string[];
  frameworks: string[];
  description: string;
  analyzedAt: string;
  gitCommitHash: string;
}

// Root KnowledgeGraph
export interface KnowledgeGraph {
  version: string;
  kind?: "codebase" | "knowledge";
  project: ProjectMeta;
  nodes: GraphNode[];
  edges: GraphEdge[];
  layers: Layer[];
  tour: TourStep[];
}

// Theme configuration (for dashboard customization)
export interface ThemeConfig {
  presetId: string;
  accentId: string;
}

// AnalysisMeta (for persistence)
export interface AnalysisMeta {
  lastAnalyzedAt: string;
  gitCommitHash: string;
  version: string;
  analyzedFiles: number;
  theme?: ThemeConfig;
}

// Project config (for auto-update opt-in and language preference)
export interface ProjectConfig {
  autoUpdate: boolean;
  outputLanguage?: string;
}

// Non-code structural sub-interfaces
export interface SectionInfo {
  name: string;
  level: number;
  lineRange: [number, number];
}

export interface DefinitionInfo {
  name: string;
  /** Parser-reported definition kind. Known values: "table", "view", "index", "message", "enum", "type", "input", "interface", "union", "scalar", "variable", "output", "resource", "data", "section", "target", "stage" */
  kind: string;
  lineRange: [number, number];
  fields: string[];
}

export interface ServiceInfo {
  name: string;
  image?: string;
  ports: number[];
  lineRange?: [number, number];
}

export interface EndpointInfo {
  method?: string;
  path: string;
  lineRange: [number, number];
}

export interface StepInfo {
  name: string;
  lineRange: [number, number];
}

export interface ResourceInfo {
  name: string;
  kind: string;
  lineRange: [number, number];
}

export interface ReferenceResolution {
  source: string;
  target: string;
  referenceType: string; // "file", "image", "schema", "service"
  line?: number;
}

// Plugin interfaces
export interface StructuralAnalysis {
  functions: Array<{ name: string; lineRange: [number, number]; params: string[]; returnType?: string }>;
  classes: Array<{ name: string; lineRange: [number, number]; methods: string[]; properties: string[] }>;
  imports: Array<{ source: string; specifiers: string[]; lineNumber: number }>;
  exports: Array<{ name: string; lineNumber: number; isDefault?: boolean }>;
  // Non-code structural data (all optional for backward compat)
  sections?: SectionInfo[];
  definitions?: DefinitionInfo[];
  services?: ServiceInfo[];
  endpoints?: EndpointInfo[];
  steps?: StepInfo[];
  resources?: ResourceInfo[];
}

export interface ImportResolution {
  source: string;
  resolvedPath: string;
  specifiers: string[];
}

export interface CallGraphEntry {
  caller: string;
  callee: string;
  lineNumber: number;
}

export interface AnalyzerPlugin {
  name: string;
  languages: string[];
  analyzeFile(filePath: string, content: string): StructuralAnalysis;
  resolveImports?(filePath: string, content: string): ImportResolution[];
  extractCallGraph?(filePath: string, content: string): CallGraphEntry[];
  extractReferences?(filePath: string, content: string): ReferenceResolution[];
}
