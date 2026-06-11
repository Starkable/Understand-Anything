/**
 * Pure data transforms for the federation view: FederationGraphData →
 * React Flow nodes/edges. Kept out of the component so it can be unit
 * tested without rendering.
 */
import type { Edge, Node } from "@xyflow/react";
import type { GraphNode, CommunityMeta } from "@understand-anything/core/types";
import type { FederationGraphData } from "../store";

export type CommunityStatus = CommunityMeta["status"];

export interface CommunityNodeData extends Record<string, unknown> {
  label: string;
  summary: string;
  serviceId?: string;
  domains: string[];
  status: CommunityStatus;
}

export type CommunityFlowNode = Node<CommunityNodeData, "community-node">;

/** Edge stroke style per cross-community link status (worst-of aggregation). */
export const STATUS_EDGE_STYLE: Record<CommunityStatus, { stroke: string; dash?: string }> = {
  resolved: { stroke: "var(--color-accent)" },
  pending: { stroke: "var(--color-text-muted)", dash: "6 4" },
  ambiguous: { stroke: "#e0b04a", dash: "3 3" },
  stale: { stroke: "#c97070", dash: "8 4" },
};

export interface BuiltFederationFlow {
  nodes: Node[];
  edges: Edge[];
  dims: Map<string, { width: number; height: number }>;
}

export function buildFederationFlow(
  graph: FederationGraphData,
  callSitesLabel: string,
): BuiltFederationFlow {
  const dims = new Map<string, { width: number; height: number }>();

  const rfNodes: CommunityFlowNode[] = graph.nodes
    .filter((n): n is GraphNode => n.type === "community")
    .map((node) => {
      dims.set(node.id, { width: 260, height: 96 });
      const meta = node.communityMeta;
      return {
        id: node.id,
        type: "community-node" as const,
        position: { x: 0, y: 0 },
        data: {
          label: node.name,
          summary: node.summary,
          serviceId: meta?.serviceId,
          domains: meta?.domains ?? [],
          status: meta?.status ?? "pending",
        },
      };
    });

  const rfEdges: Edge[] = graph.edges
    .filter((e) => e.type === "calls_community")
    .map((e, i) => {
      const meta = e.communityMeta;
      const status: CommunityStatus = meta?.status ?? "pending";
      const style = STATUS_EDGE_STYLE[status];
      const callCount = e.callCount;
      return {
        id: `fed-${i}-${e.source}-${e.target}`,
        source: e.source,
        target: e.target,
        label: callCount ? `${callCount} ${callSitesLabel}` : e.description ?? "",
        style: {
          stroke: style.stroke,
          strokeWidth: 2,
          ...(style.dash ? { strokeDasharray: style.dash } : {}),
        },
        labelStyle: { fill: "var(--color-text-muted)", fontSize: 10 },
        labelBgStyle: { fill: "var(--color-surface)", fillOpacity: 0.9 },
        labelBgPadding: [6, 4] as [number, number],
        labelBgBorderRadius: 4,
        animated: status === "resolved",
      };
    });

  return { nodes: rfNodes as unknown as Node[], edges: rfEdges, dims };
}
