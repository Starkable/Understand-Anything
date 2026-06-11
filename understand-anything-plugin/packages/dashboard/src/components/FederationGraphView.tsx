import { useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
} from "@xyflow/react";
import type { Edge, Node, NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useDashboardStore } from "../store";
import { useI18n } from "../contexts/I18nContext";
import { mergeElkPositions, nodesToElkInput } from "../utils/layout";
import { applyElkLayout } from "../utils/elk-layout";
import { buildFederationFlow } from "../utils/federationFlow";
import type { BuiltFederationFlow, CommunityFlowNode } from "../utils/federationFlow";

/** Federation portal node: one card per service community. */
function CommunityNode({ data, selected }: NodeProps<CommunityFlowNode>) {
  const { t } = useI18n();
  const pending = data.status === "pending";
  const statusLabel =
    data.status === "pending" ? t.federation.pending : t.federation.analyzed;

  return (
    <div
      className={`rounded-xl px-4 py-3 w-[260px] transition-colors bg-surface ${
        pending
          ? "border-2 border-dashed border-border-medium opacity-75"
          : "border border-accent/40"
      } ${selected ? "ring-2 ring-accent" : ""}`}
    >
      <Handle type="target" position={Position.Left} className="!bg-accent/60" />
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded text-accent border border-accent/30 bg-accent/10">
          {t.federation.community}
        </span>
        <span
          className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${
            pending
              ? "text-text-muted border border-border-medium"
              : "text-node-function border border-node-function/30 bg-node-function/10"
          }`}
        >
          {statusLabel}
        </span>
      </div>
      <div className="font-heading text-sm text-text-primary truncate" title={data.label}>
        {data.label}
      </div>
      {data.domains.length > 0 && (
        <div className="mt-1 text-[10px] font-mono text-text-muted truncate" title={data.domains.join(", ")}>
          {data.domains.join(", ")}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!bg-accent/60" />
    </div>
  );
}

const nodeTypes = { "community-node": CommunityNode };

function FederationGraphViewInner() {
  const federationGraph = useDashboardStore((s) => s.federationGraph);
  const { t } = useI18n();

  const built = useMemo<BuiltFederationFlow | null>(() => {
    if (!federationGraph) return null;
    return buildFederationFlow(federationGraph, t.federation.callSites);
  }, [federationGraph, t]);

  const [layout, setLayout] = useState<{ nodes: Node[]; edges: Edge[] }>({
    nodes: [],
    edges: [],
  });

  useEffect(() => {
    if (!built) {
      setLayout({ nodes: [], edges: [] });
      return;
    }
    let cancelled = false;
    const { nodes: nodesArray, edges: edgesArray, dims } = built;
    const elkInput = nodesToElkInput(nodesArray, edgesArray, dims, {
      "elk.direction": "RIGHT",
    });
    applyElkLayout(elkInput, { strict: import.meta.env.DEV })
      .then(({ positioned, issues }) => {
        if (cancelled) return;
        if (issues.length > 0) {
          useDashboardStore.getState().appendLayoutIssues(issues);
        }
        setLayout({
          nodes: mergeElkPositions(nodesArray, positioned),
          edges: edgesArray,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[federation ELK] layout failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [built]);

  if (!federationGraph || federationGraph.nodes.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-text-muted text-sm px-8 text-center">
        {t.federation.empty}
      </div>
    );
  }

  const { nodes, edges } = layout;

  return (
    <div className="h-full w-full relative">
      <div className="absolute top-3 left-3 z-10 px-3 py-1.5 text-xs rounded-lg bg-elevated border border-border-subtle text-text-secondary pointer-events-none select-none">
        {t.federation.title}
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="var(--color-border-subtle)"
        />
        <Controls />
        <MiniMap
          nodeColor="var(--color-accent)"
          maskColor="var(--glass-bg)"
          className="!bg-surface !border !border-border-subtle"
        />
      </ReactFlow>
    </div>
  );
}

export default function FederationGraphView() {
  return (
    <ReactFlowProvider>
      <FederationGraphViewInner />
    </ReactFlowProvider>
  );
}
