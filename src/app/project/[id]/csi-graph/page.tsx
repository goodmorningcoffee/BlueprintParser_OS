"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import {
  forceSimulation,
  forceCenter,
  forceManyBody,
  forceLink,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";

// ═══════════════════════════════════════════════════════════════════
// Types (mirrors csi-graph.ts but client-safe)
// ═══════════════════════════════════════════════════════════════════

interface GraphNode {
  division: string;
  name: string;
  totalInstances: number;
  pageCount: number;
  pages: number[];
}
interface GraphEdge {
  source: string;
  target: string;
  weight: number;
  type: "co-occurrence" | "cross-reference" | "containment";
  pages: number[];
}
interface GraphCluster {
  name: string;
  divisions: string[];
  cohesion: number;
}
interface CsiGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: GraphCluster[];
  fingerprint: string;
}

// D3 simulation node
interface SimNode extends SimulationNodeDatum {
  id: string;
  division: string;
  name: string;
  totalInstances: number;
  pageCount: number;
  pages: number[];
  radius: number;
  color: string;
  group: string;
}

// D3 simulation link
interface SimLink extends SimulationLinkDatum<SimNode> {
  weight: number;
  type: string;
  pages: number[];
}

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

const DIVISION_COLORS: Record<string, { color: string; group: string }> = {
  "22": { color: "#3b82f6", group: "MEP" },
  "23": { color: "#60a5fa", group: "MEP" },
  "26": { color: "#2563eb", group: "MEP" },
  "27": { color: "#818cf8", group: "MEP" },
  "28": { color: "#6366f1", group: "MEP" },
  "21": { color: "#38bdf8", group: "MEP" },
  "08": { color: "#22c55e", group: "Architectural" },
  "09": { color: "#4ade80", group: "Architectural" },
  "12": { color: "#86efac", group: "Architectural" },
  "10": { color: "#a7f3d0", group: "Architectural" },
  "03": { color: "#f97316", group: "Structural" },
  "05": { color: "#fb923c", group: "Structural" },
  "04": { color: "#fdba74", group: "Structural" },
  "06": { color: "#fbbf24", group: "Structural" },
  "31": { color: "#a16207", group: "Site" },
  "32": { color: "#ca8a04", group: "Site" },
  "33": { color: "#d97706", group: "Site" },
};

const GROUP_COLORS: Record<string, string> = {
  MEP: "#3b82f6",
  Architectural: "#22c55e",
  Structural: "#f97316",
  Site: "#a16207",
  Other: "#6b7280",
};

function getDivColor(div: string): { color: string; group: string } {
  return DIVISION_COLORS[div] || { color: "#6b7280", group: "Other" };
}

// ═══════════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════════

export default function CsiGraphPage() {
  const { id } = useParams<{ id: string }>();
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);

  // Data state
  const [graph, setGraph] = useState<CsiGraph | null>(null);
  const [projectName, setProjectName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Simulation output
  const [simNodes, setSimNodes] = useState<SimNode[]>([]);
  const [simLinks, setSimLinks] = useState<SimLink[]>([]);

  // Controls
  const [chargeStrength, setChargeStrength] = useState(-250);
  const [minEdgeWeight, setMinEdgeWeight] = useState(0);
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [edgeTypeFilter, setEdgeTypeFilter] = useState<"all" | "co-occurrence" | "cross-reference">("all");
  const [showLabels, setShowLabels] = useState(true);

  // Interaction
  const [selectedNode, setSelectedNode] = useState<SimNode | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<SimLink | null>(null);
  const [hoveredEdgePos, setHoveredEdgePos] = useState<{ x: number; y: number } | null>(null);

  // Zoom/pan
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const panRef = useRef<{ active: boolean; startX: number; startY: number; origX: number; origY: number }>({
    active: false, startX: 0, startY: 0, origX: 0, origY: 0,
  });

  // Drag
  const dragRef = useRef<{ active: boolean; node: SimNode | null }>({ active: false, node: null });

  // Viewport
  const [size, setSize] = useState({ w: 800, h: 600 });

  useEffect(() => {
    function onResize() {
      setSize({ w: window.innerWidth, h: window.innerHeight });
    }
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ── Fetch project data ──────────────────────────────────────────
  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      // Try authenticated first, fall back to demo
      let data: any = null;
      for (const url of [`/api/projects/${id}`, `/api/demo/projects/${id}`]) {
        try {
          const res = await fetch(url);
          if (res.ok) {
            data = await res.json();
            break;
          }
        } catch { /* try next */ }
      }

      if (cancelled) return;

      if (!data?.projectIntelligence?.csiGraph) {
        setError("No CSI graph data available for this project. Process the project first.");
        setLoading(false);
        return;
      }

      setProjectName(data.name || "Project");
      setGraph(data.projectIntelligence.csiGraph as CsiGraph);
      setLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, [id]);

  // ── Build & run simulation ──────────────────────────────────────
  const buildSimulation = useCallback(
    (g: CsiGraph, width: number, height: number, charge: number) => {
      // Stop previous
      simRef.current?.stop();

      // Map nodes
      const maxInstances = Math.max(...g.nodes.map((n) => n.totalInstances), 1);
      const nodes: SimNode[] = g.nodes.map((n) => {
        const { color, group } = getDivColor(n.division);
        return {
          id: n.division,
          division: n.division,
          name: n.name,
          totalInstances: n.totalInstances,
          pageCount: n.pageCount,
          pages: n.pages,
          radius: 18 + (n.totalInstances / maxInstances) * 32,
          color,
          group,
          x: width / 2 + (Math.random() - 0.5) * 200,
          y: height / 2 + (Math.random() - 0.5) * 200,
        };
      });

      // Map links
      const nodeMap = new Map(nodes.map((n) => [n.division, n]));
      const links: SimLink[] = g.edges
        .filter((e) => nodeMap.has(e.source) && nodeMap.has(e.target))
        .map((e) => ({
          source: nodeMap.get(e.source)!,
          target: nodeMap.get(e.target)!,
          weight: e.weight,
          type: e.type,
          pages: e.pages,
        }));

      const maxWeight = Math.max(...links.map((l) => l.weight), 1);

      // Create simulation
      const sim = forceSimulation(nodes)
        .force("center", forceCenter(width / 2, height / 2))
        .force("charge", forceManyBody().strength(charge))
        .force(
          "link",
          forceLink<SimNode, SimLink>(links)
            .id((d) => d.id)
            .distance((d) => 120 - (d.weight / maxWeight) * 60)
            .strength((d) => 0.3 + (d.weight / maxWeight) * 0.7)
        )
        .force("collide", forceCollide<SimNode>().radius((d) => d.radius + 8));

      // Run to convergence synchronously, then animate the last few ticks
      sim.tick(200);

      // Set positions
      setSimNodes([...nodes]);
      setSimLinks([...links]);

      // Continue ticking for smooth animation
      sim.alpha(0.1).restart();
      sim.on("tick", () => {
        setSimNodes([...nodes]);
        setSimLinks([...links]);
      });

      simRef.current = sim;
    },
    []
  );

  useEffect(() => {
    if (!graph) return;
    const headerH = 56;
    const controlsH = 48;
    buildSimulation(graph, size.w, size.h - headerH - controlsH, chargeStrength);
    return () => { simRef.current?.stop(); };
  }, [graph, size.w, size.h, chargeStrength, buildSimulation]);

  // ── Zoom: mouse wheel ───────────────────────────────────────────
  function handleWheel(e: React.WheelEvent) {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const newK = Math.max(0.1, Math.min(5, transform.k * factor));

    setTransform({
      x: mx - ((mx - transform.x) / transform.k) * newK,
      y: my - ((my - transform.y) / transform.k) * newK,
      k: newK,
    });
  }

  // ── Pan: mouse drag on background ──────────────────────────────
  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    if ((e.target as SVGElement).closest(".graph-node")) return;
    panRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      origX: transform.x,
      origY: transform.y,
    };
  }

  function handleMouseMove(e: React.MouseEvent) {
    // Pan
    if (panRef.current.active) {
      const dx = e.clientX - panRef.current.startX;
      const dy = e.clientY - panRef.current.startY;
      setTransform((t) => ({ ...t, x: panRef.current.origX + dx, y: panRef.current.origY + dy }));
      return;
    }
    // Drag node
    if (dragRef.current.active && dragRef.current.node) {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const x = (e.clientX - rect.left - transform.x) / transform.k;
      const y = (e.clientY - rect.top - transform.y) / transform.k;
      dragRef.current.node.fx = x;
      dragRef.current.node.fy = y;
      simRef.current?.alpha(0.3).restart();
    }
  }

  function handleMouseUp() {
    panRef.current.active = false;
    if (dragRef.current.active && dragRef.current.node) {
      dragRef.current.node.fx = null;
      dragRef.current.node.fy = null;
      dragRef.current = { active: false, node: null };
      simRef.current?.alpha(0.1).restart();
    }
  }

  // ── Node drag ──────────────────────────────────────────────────
  function handleNodeMouseDown(e: React.MouseEvent, node: SimNode) {
    e.stopPropagation();
    dragRef.current = { active: true, node };
  }

  // ── Search match ────────────────────────────────────────────────
  const searchMatch = searchQuery.trim().toLowerCase();
  const matchedDivisions = searchMatch
    ? new Set(
        simNodes
          .filter(
            (n) =>
              n.division.includes(searchMatch) ||
              n.name.toLowerCase().includes(searchMatch) ||
              n.group.toLowerCase().includes(searchMatch)
          )
          .map((n) => n.division)
      )
    : null;

  // ── Visible nodes (group filter) ──────────────────────────────
  const visibleNodes = simNodes.filter((n) => !hiddenGroups.has(n.group));
  const visibleDivisions = new Set(visibleNodes.map((n) => n.division));

  // ── Filtered edges ─────────────────────────────────────────────
  const filteredLinks = simLinks.filter(
    (l) =>
      l.weight >= minEdgeWeight &&
      (edgeTypeFilter === "all" || l.type === edgeTypeFilter) &&
      visibleDivisions.has((l.source as SimNode).division) &&
      visibleDivisions.has((l.target as SimNode).division)
  );
  const maxWeight = Math.max(...simLinks.map((l) => l.weight), 1);

  // ── Selected node connections ──────────────────────────────────
  const connectedDivisions = selectedNode
    ? new Set(
        filteredLinks
          .filter(
            (l) =>
              (l.source as SimNode).division === selectedNode.division ||
              (l.target as SimNode).division === selectedNode.division
          )
          .flatMap((l) => [(l.source as SimNode).division, (l.target as SimNode).division])
      )
    : null;

  const connectedEdges = selectedNode
    ? filteredLinks.filter(
        (l) =>
          (l.source as SimNode).division === selectedNode.division ||
          (l.target as SimNode).division === selectedNode.division
      )
    : [];

  // ── Node visibility: combines group filter, search, and selection ─
  function getNodeOpacity(node: SimNode): number {
    if (!visibleDivisions.has(node.division)) return 0;
    if (matchedDivisions && !matchedDivisions.has(node.division)) return 0.1;
    if (selectedNode && !connectedDivisions?.has(node.division)) return 0.15;
    return 1;
  }

  function getEdgeOpacity(link: SimLink): number {
    const src = link.source as SimNode;
    const tgt = link.target as SimNode;
    if (matchedDivisions && !matchedDivisions.has(src.division) && !matchedDivisions.has(tgt.division)) return 0.02;
    if (selectedNode) {
      if (src.division === selectedNode.division || tgt.division === selectedNode.division) return 0.5;
      return 0.03;
    }
    return 0.2;
  }

  // ── Viewer URL builder (for page navigation) ──────────────────
  function viewerPageUrl(pageNum: number): string {
    return `/demo/project/${id}?page=${pageNum}`;
  }

  // ═══════════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════════

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-[var(--bg)] text-[var(--muted)]">
        Loading graph data...
      </div>
    );
  }

  if (error || !graph) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-4 bg-[var(--bg)]">
        <span className="text-red-400 text-sm">{error || "No graph data"}</span>
        <button onClick={() => window.close()} className="text-sm text-[var(--accent)] hover:underline">
          Close
        </button>
      </div>
    );
  }

  const headerH = 56;
  const controlsH = 48;
  const svgH = size.h - headerH - controlsH;

  return (
    <div className="h-screen flex flex-col bg-[var(--bg)] text-[var(--fg)] overflow-hidden select-none">
      {/* ── Header ──────────────────────────────────────────────── */}
      <header
        className="flex items-center justify-between px-4 shrink-0 border-b border-[var(--border)]"
        style={{ height: headerH }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={() => window.close()}
            className="text-xs px-2 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:bg-[var(--surface)]"
          >
            &larr; Back
          </button>
          <div>
            <h1 className="text-sm font-medium">{projectName} — CSI Network Graph</h1>
            <p className="text-[10px] text-[var(--muted)]">
              {graph.nodes.length} divisions &middot; {graph.edges.length} connections &middot;{" "}
              {graph.clusters.length} clusters
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {graph.fingerprint && (
            <button
              onClick={() => navigator.clipboard.writeText(graph.fingerprint)}
              className="text-[10px] px-2 py-1 rounded bg-[var(--surface)] border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] font-mono truncate max-w-[200px]"
              title={graph.fingerprint}
            >
              FP: {graph.fingerprint.length > 30 ? graph.fingerprint.slice(0, 30) + "..." : graph.fingerprint}
            </button>
          )}
        </div>
      </header>

      {/* ── SVG Graph ───────────────────────────────────────────── */}
      <div className="flex-1 relative" style={{ height: svgH }}>
        <svg
          ref={svgRef}
          width={size.w}
          height={svgH}
          className="cursor-grab active:cursor-grabbing"
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
            {/* Cluster hulls */}
            {graph.clusters.map((cluster) => {
              const clusterNodes = simNodes.filter((n) => cluster.divisions.includes(n.division));
              if (clusterNodes.length < 2) return null;
              const cx = clusterNodes.reduce((s, n) => s + (n.x || 0), 0) / clusterNodes.length;
              const cy = clusterNodes.reduce((s, n) => s + (n.y || 0), 0) / clusterNodes.length;
              const maxDist = Math.max(
                ...clusterNodes.map((n) => Math.hypot((n.x || 0) - cx, (n.y || 0) - cy))
              );
              const groupColor = GROUP_COLORS[cluster.name] || GROUP_COLORS.Other;
              return (
                <g key={cluster.name}>
                  <circle
                    cx={cx}
                    cy={cy}
                    r={maxDist + 50}
                    fill={groupColor}
                    opacity={0.06}
                    stroke={groupColor}
                    strokeOpacity={0.15}
                    strokeWidth={1}
                    strokeDasharray="4 2"
                  />
                  <text
                    x={cx}
                    y={cy - maxDist - 55}
                    textAnchor="middle"
                    fill={groupColor}
                    opacity={0.5}
                    fontSize={11}
                    fontWeight={500}
                  >
                    {cluster.name} ({Math.round(cluster.cohesion * 100)}%)
                  </text>
                </g>
              );
            })}

            {/* Edges */}
            {filteredLinks.map((link, i) => {
              const src = link.source as SimNode;
              const tgt = link.target as SimNode;
              const strokeW = 1 + (link.weight / maxWeight) * 5;
              const opacity = getEdgeOpacity(link);

              return (
                <line
                  key={i}
                  x1={src.x || 0}
                  y1={src.y || 0}
                  x2={tgt.x || 0}
                  y2={tgt.y || 0}
                  stroke="#ffffff"
                  strokeOpacity={opacity}
                  strokeWidth={strokeW}
                  strokeDasharray={link.type === "cross-reference" ? "6 3" : undefined}
                  style={{ cursor: "pointer", transition: "stroke-opacity 0.2s" }}
                  onMouseEnter={(e) => {
                    setHoveredEdge(link);
                    setHoveredEdgePos({ x: e.clientX, y: e.clientY });
                  }}
                  onMouseLeave={() => {
                    setHoveredEdge(null);
                    setHoveredEdgePos(null);
                  }}
                />
              );
            })}

            {/* Nodes */}
            {simNodes.map((node) => {
              const isSelected = selectedNode?.division === node.division;
              const isSearchHit = matchedDivisions?.has(node.division);
              const nodeOpacity = getNodeOpacity(node);
              if (nodeOpacity === 0) return null;

              return (
                <g
                  key={node.division}
                  className="graph-node"
                  transform={`translate(${node.x || 0},${node.y || 0})`}
                  style={{ cursor: "pointer", transition: "opacity 0.2s" }}
                  opacity={nodeOpacity}
                  onMouseDown={(e) => handleNodeMouseDown(e, node)}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedNode(isSelected ? null : node);
                  }}
                >
                  {/* Search highlight ring */}
                  {isSearchHit && !isSelected && (
                    <circle r={node.radius + 8} fill="none" stroke="#fbbf24" strokeWidth={2} opacity={0.8}>
                      <animate attributeName="r" from={node.radius + 6} to={node.radius + 12} dur="1.5s" repeatCount="indefinite" />
                      <animate attributeName="opacity" from="0.8" to="0.2" dur="1.5s" repeatCount="indefinite" />
                    </circle>
                  )}
                  {/* Glow ring for selected */}
                  {isSelected && (
                    <circle r={node.radius + 6} fill="none" stroke={node.color} strokeWidth={2} opacity={0.6} />
                  )}
                  {/* Node circle */}
                  <circle
                    r={node.radius}
                    fill={node.color}
                    fillOpacity={isSelected ? 0.9 : 0.7}
                    stroke={isSelected ? "#fff" : node.color}
                    strokeWidth={isSelected ? 2 : 1}
                    strokeOpacity={0.5}
                  />
                  {/* Division code */}
                  <text
                    textAnchor="middle"
                    dy={showLabels ? -3 : 4}
                    fill="#fff"
                    fontSize={node.radius > 25 ? 14 : 11}
                    fontWeight={700}
                    pointerEvents="none"
                  >
                    {node.division}
                  </text>
                  {/* Division name (when labels enabled) */}
                  {showLabels && (
                    <text
                      textAnchor="middle"
                      dy={10}
                      fill="#fff"
                      fontSize={node.radius > 25 ? 9 : 7}
                      fontWeight={400}
                      opacity={0.85}
                      pointerEvents="none"
                    >
                      {node.name.length > 14 ? node.name.slice(0, 12) + "..." : node.name}
                    </text>
                  )}
                  {/* Instance count badge */}
                  {showLabels && (
                    <text
                      textAnchor="middle"
                      dy={node.radius + 14}
                      fill={node.color}
                      fontSize={9}
                      fontWeight={500}
                      opacity={0.7}
                      pointerEvents="none"
                    >
                      {node.totalInstances} hits &middot; {node.pageCount}p
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* ── Edge tooltip ────────────────────────────────────── */}
        {hoveredEdge && hoveredEdgePos && (
          <div
            className="absolute z-20 px-3 py-2 rounded-lg bg-[var(--surface)] border border-[var(--border)] shadow-lg pointer-events-none"
            style={{ left: hoveredEdgePos.x + 12, top: hoveredEdgePos.y - 60 }}
          >
            <div className="text-xs font-medium">
              {(hoveredEdge.source as SimNode).division} {(hoveredEdge.source as SimNode).name}
              <span className="text-[var(--muted)]"> &harr; </span>
              {(hoveredEdge.target as SimNode).division} {(hoveredEdge.target as SimNode).name}
            </div>
            <div className="text-[10px] text-[var(--muted)] mt-0.5">
              Weight: {hoveredEdge.weight} &middot; {hoveredEdge.type}
              {hoveredEdge.pages.length > 0 && (
                <> &middot; Pages: {hoveredEdge.pages.slice(0, 8).join(", ")}
                  {hoveredEdge.pages.length > 8 && ` +${hoveredEdge.pages.length - 8}`}
                </>
              )}
            </div>
          </div>
        )}

        {/* ── Selected node detail panel ─────────────────────── */}
        {selectedNode && (
          <div className="absolute top-3 right-3 z-10 w-64 rounded-lg bg-[var(--surface)] border border-[var(--border)] shadow-xl overflow-hidden">
            <div className="px-3 py-2 border-b border-[var(--border)] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: selectedNode.color }} />
                <span className="text-sm font-medium">
                  {selectedNode.division} — {selectedNode.name}
                </span>
              </div>
              <button
                onClick={() => setSelectedNode(null)}
                className="text-[var(--muted)] hover:text-[var(--fg)] text-xs"
              >
                &times;
              </button>
            </div>
            <div className="px-3 py-2 space-y-2 max-h-[50vh] overflow-y-auto text-xs">
              {/* Stats */}
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-[var(--bg)] rounded px-2 py-1.5">
                  <div className="text-[var(--muted)] text-[9px]">CSI Hits</div>
                  <div className="text-base font-semibold">{selectedNode.totalInstances}</div>
                </div>
                <div className="bg-[var(--bg)] rounded px-2 py-1.5">
                  <div className="text-[var(--muted)] text-[9px]">Pages</div>
                  <div className="text-base font-semibold">{selectedNode.pageCount}</div>
                </div>
              </div>

              {/* Connected divisions */}
              {connectedEdges.length > 0 && (
                <div>
                  <div className="text-[9px] text-[var(--muted)] font-medium mb-1">
                    Connected Divisions ({connectedEdges.length})
                  </div>
                  <div className="space-y-0.5">
                    {connectedEdges
                      .sort((a, b) => b.weight - a.weight)
                      .map((edge, i) => {
                        const other =
                          (edge.source as SimNode).division === selectedNode.division
                            ? (edge.target as SimNode)
                            : (edge.source as SimNode);
                        return (
                          <div key={i} className="flex items-center gap-1.5 text-[10px]">
                            <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: other.color }} />
                            <span className="text-[var(--fg)]">
                              {other.division} {other.name}
                            </span>
                            <span className="text-[var(--muted)] ml-auto shrink-0">
                              wt {edge.weight}
                              {edge.type === "cross-reference" && " (xref)"}
                            </span>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* Pages list with links */}
              <div>
                <div className="text-[9px] text-[var(--muted)] font-medium mb-1">
                  Pages ({selectedNode.pages.length})
                </div>
                <div className="flex flex-wrap gap-1">
                  {selectedNode.pages.map((p) => (
                    <a
                      key={p}
                      href={viewerPageUrl(p)}
                      target="_blank"
                      rel="noreferrer"
                      className="px-1.5 py-0.5 rounded bg-[var(--bg)] text-[10px] text-[var(--accent)] hover:bg-[var(--accent)]/20 border border-[var(--border)]"
                    >
                      p{p}
                    </a>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Legend (bottom-right) ──────────────────────────── */}
        <div className="absolute bottom-3 right-3 z-10 px-3 py-2 rounded-lg bg-[var(--surface)]/90 border border-[var(--border)] backdrop-blur-sm">
          <div className="text-[9px] text-[var(--muted)] font-medium mb-1.5">Legend</div>
          <div className="space-y-1">
            {Object.entries(GROUP_COLORS).map(([name, color]) => (
              <div key={name} className="flex items-center gap-1.5 text-[10px]">
                <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
                <span className="text-[var(--fg)]">{name}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 pt-1.5 border-t border-[var(--border)] space-y-0.5 text-[9px] text-[var(--muted)]">
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-[2px] bg-white/30" />
              <span>Co-occurrence</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-[2px] bg-white/30" style={{ borderTop: "2px dashed rgba(255,255,255,0.3)" }} />
              <span>Cross-reference</span>
            </div>
            <div className="mt-1 text-[8px]">Node size = CSI hit count</div>
          </div>
        </div>
      </div>

      {/* ── Controls bar ────────────────────────────────────────── */}
      <div
        className="flex items-center gap-3 px-4 shrink-0 border-t border-[var(--border)] bg-[var(--surface)] overflow-x-auto"
        style={{ height: controlsH }}
      >
        {/* Search */}
        <div className="flex items-center gap-1.5 shrink-0">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search division..."
            className="w-32 px-2 py-1 text-[10px] bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--muted)]"
          />
        </div>

        {/* Divider */}
        <div className="w-px h-5 bg-[var(--border)] shrink-0" />

        {/* Group toggles */}
        <div className="flex items-center gap-1 shrink-0">
          {Object.entries(GROUP_COLORS).map(([name, color]) => {
            const hidden = hiddenGroups.has(name);
            return (
              <button
                key={name}
                onClick={() => {
                  const next = new Set(hiddenGroups);
                  if (hidden) next.delete(name); else next.add(name);
                  setHiddenGroups(next);
                }}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                  hidden
                    ? "border-[var(--border)] text-[var(--muted)] opacity-40"
                    : "border-transparent text-[var(--fg)]"
                }`}
              >
                <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color, opacity: hidden ? 0.3 : 1 }} />
                {name}
              </button>
            );
          })}
        </div>

        <div className="w-px h-5 bg-[var(--border)] shrink-0" />

        {/* Edge type */}
        <div className="flex items-center gap-1 shrink-0">
          {(["all", "co-occurrence", "cross-reference"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setEdgeTypeFilter(t)}
              className={`px-1.5 py-0.5 rounded text-[10px] border ${
                edgeTypeFilter === t
                  ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10"
                  : "border-[var(--border)] text-[var(--muted)]"
              }`}
            >
              {t === "all" ? "All edges" : t === "co-occurrence" ? "Co-occur" : "X-ref"}
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-[var(--border)] shrink-0" />

        {/* Sliders */}
        <div className="flex items-center gap-1.5 shrink-0">
          <label className="text-[var(--muted)] text-[10px]">Spread</label>
          <input
            type="range" min={-500} max={-50} step={10}
            value={chargeStrength}
            onChange={(e) => setChargeStrength(Number(e.target.value))}
            className="w-20 accent-[var(--accent)]"
          />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <label className="text-[var(--muted)] text-[10px]">Min wt</label>
          <input
            type="range" min={0} max={maxWeight} step={1}
            value={minEdgeWeight}
            onChange={(e) => setMinEdgeWeight(Number(e.target.value))}
            className="w-20 accent-[var(--accent)]"
          />
          <span className="text-[10px] text-[var(--muted)] w-4">{minEdgeWeight}</span>
        </div>

        <div className="w-px h-5 bg-[var(--border)] shrink-0" />

        {/* Labels toggle */}
        <button
          onClick={() => setShowLabels(!showLabels)}
          className={`px-1.5 py-0.5 rounded text-[10px] border shrink-0 ${
            showLabels
              ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10"
              : "border-[var(--border)] text-[var(--muted)]"
          }`}
        >
          Labels
        </button>

        {/* Reset */}
        <button
          onClick={() => {
            setSelectedNode(null);
            setSearchQuery("");
            setHiddenGroups(new Set());
            setEdgeTypeFilter("all");
            setMinEdgeWeight(0);
            setChargeStrength(-250);
            setShowLabels(true);
            setTransform({ x: 0, y: 0, k: 1 });
          }}
          className="px-1.5 py-0.5 rounded text-[10px] border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] shrink-0"
        >
          Reset
        </button>

        {/* Help text */}
        <span className="text-[9px] text-[var(--muted)] ml-auto shrink-0 hidden lg:inline">
          Scroll=zoom &middot; Drag=pan &middot; Drag node=reposition &middot; Click node=inspect
        </span>
      </div>
    </div>
  );
}
