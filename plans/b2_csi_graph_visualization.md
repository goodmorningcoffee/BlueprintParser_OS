# Plan: B2 — Full CSI Network Graph Visualization Page

## What

A standalone page at `/project/[id]/csi-graph` that renders an interactive 2D force-directed graph of CSI division relationships for a project. The CsiPanel already has an "Open Full Graph →" link pointing here.

## Prerequisites

```bash
npm install d3-force d3-selection
```

## File to Create

`src/app/project/[id]/csi-graph/page.tsx`

## Data Source

- Fetch project via `GET /api/projects/[id]` (or `/api/demo/projects/[id]`)
- Read `response.projectIntelligence.csiGraph` which contains:
  - `nodes: { division, name, totalInstances, pageCount, pages }[]`
  - `edges: { source, target, weight, type, pages }[]`
  - `clusters: { name, divisions, cohesion }[]`
  - `fingerprint: string`

## Graph Rendering

**Nodes:**
- Circles sized by `totalInstances` (min 20px, max 60px radius)
- Colored by division group:
  - MEP (22,23,26,27,28) = blue family (#3b82f6)
  - Architectural (08,09,12) = green family (#22c55e)
  - Structural (03,05) = orange family (#f97316)
  - Site (31,32,33) = brown family (#a16207)
  - Other = gray (#6b7280)
- Label: division code + name (e.g. "08 Openings")

**Edges:**
- Lines with thickness proportional to `weight` (1px to 6px)
- Dashed for `type === "cross-reference"`, solid for `"co-occurrence"`
- Color: semi-transparent white (#ffffff30)

**Clusters:**
- Subtle background hull/bubble around clustered divisions (convex hull of cluster node positions)
- Very low opacity fill matching the group color

## Layout

- `d3-force` simulation with:
  - `forceCenter()` — centers the graph
  - `forceManyBody()` — repulsion between nodes (charge strength controlled by slider)
  - `forceLink()` — edges pull connected nodes together (distance inversely proportional to weight)
  - `forceCollide()` — prevent node overlap based on radius

## Controls

| Control | Implementation |
|---------|---------------|
| **Zoom** | Mouse wheel → scale SVG transform. Pinch zoom on touch. |
| **Pan** | Click-and-drag on background → translate SVG transform. |
| **Node spread slider** | Range input controlling `forceManyBody().strength()`. Default: -200. Range: -50 (dense) to -500 (sparse). On change, reheat simulation. |
| **Min edge weight filter** | Range input (0 to max weight). Edges below threshold hidden. |
| **Click node** | Highlight node + connected edges. Show tooltip panel: division name, instance count, page count, page list, connected divisions. |
| **Hover edge** | Show tooltip: source ↔ target, weight, type, shared pages. |

## Header Bar

```
[← Back to Project]  Project Name — CSI Network Graph
                      12 divisions · 34 connections · 3 clusters
                      [Copy Fingerprint]
```

## Legend (bottom-right corner)

Color swatches for each division group (MEP, Architectural, Structural, Site, Other) with labels. Node size legend (small = few instances, large = many).

## Page Structure

```tsx
"use client";

export default function CsiGraphPage({ params }: { params: Promise<{ id: string }> }) {
  // 1. Resolve params
  // 2. Fetch project data (try authenticated first, fall back to demo)
  // 3. Extract csiGraph from projectIntelligence
  // 4. Initialize d3-force simulation
  // 5. Render SVG with nodes, edges, labels
  // 6. Controls bar (spread slider, edge filter, legend)
  // 7. Tooltip panel for selected node/hovered edge
}
```

## Key Implementation Notes

- Use `useRef` for the SVG element, `useEffect` for d3 simulation lifecycle
- Simulation runs on mount, updates node/edge positions via `simulation.on("tick", ...)`
- Zoom/pan via `d3.zoom()` behavior attached to SVG
- Node drag via `d3.drag()` — pins node position during drag, releases after
- Responsive: SVG fills viewport, recalculates on resize
- Dark theme: match the app's CSS variables (`--bg`, `--fg`, `--border`, `--surface`)

## Estimated Effort

~2-3 hours (d3-force setup + SVG rendering + controls + tooltips + styling)
