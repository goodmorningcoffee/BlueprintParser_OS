# CSV Editor Panel — Inline Editable Takeoff Grid

## Status: Planning
## Date: April 6, 2026

---

## Problem
The current TakeoffCsvModal is a fullscreen overlay that blocks the PDF viewer. User can't see the blueprint while editing CSV data. When tracing polygons, user has to close the modal, draw, then reopen to see quantities. No way to delete/add rows or move the panel out of the way.

## Solution
Dockable, resizable CSV editor panel that lives alongside the PDF viewer. Editable grid with row operations (add, delete). Deleting a row = deleting that takeoff line item. Adding a row = adding a new takeoff item. Real-time quantity updates as user draws polygons.

---

## Design

### Panel Architecture

The CSV editor is a **new right-side panel** (like ChatPanel, TakeoffPanel) that can also be **undocked as a floating draggable window**.

**Two modes:**
1. **Docked** — slides in from right, shares space with viewer (50/50 or adjustable split). Standard panel toggle button.
2. **Floating** — draggable window with resize handles. Can be moved anywhere over the viewer. Title bar for drag, corner handles for resize.

### Data Model (uses existing)

Each row in the grid = one `ClientTakeoffItem`:
```typescript
interface ClientTakeoffItem {
  id: number;
  name: string;
  shape: "polygon" | "linear" | "count";
  color: string;
  size: number;
  notes?: string;
  groupId?: number | null;
  sortOrder: number;
}
```

Columns:
| Column | Source | Editable |
|---|---|---|
| Name | takeoffItem.name | ✅ |
| Type | takeoffItem.shape | ❌ (read-only chip) |
| Color | takeoffItem.color | ✅ (color picker) |
| Qty/Area/Length | computed from annotations | ❌ (auto-updated) |
| Unit | from scaleCalibration | ❌ |
| Pages | computed (which pages have instances) | ❌ |
| Notes | takeoffItem.notes | ✅ |
| Group | takeoffItem.groupId → group name | ✅ (dropdown) |

### Row Operations

**Delete row** = delete the takeoff item + all its annotations:
- Confirmation dialog: "Delete '{name}' and all {N} instances across {M} pages?"
- Calls `DELETE /api/takeoff-items/{id}` (already exists)
- Removes from viewerStore.takeoffItems + filters annotations
- Row disappears from grid

**Add row** = create new takeoff item:
- Inline "+" row at bottom of grid
- User types name, selects shape type (polygon/linear/count), picks color
- Calls `POST /api/takeoff-items` (already exists)
- New row appears, auto-activated for drawing

### Real-Time Updates

When user draws a polygon/line/count marker:
1. `savePolygon()` / `saveLinearPolyline()` / `saveCountMarker()` in AnnotationOverlay fires
2. Annotation added to viewerStore.annotations
3. CSV panel subscribes to a derived `useTakeoffRows()` slice:
```typescript
const useTakeoffRows = () => useViewerStore(useShallow((s) => {
  return s.takeoffItems.map(item => ({
    ...item,
    quantity: computeQuantity(item, s.annotations, s.scaleCalibrations, s.pageDimensions),
    pages: uniquePages(item, s.annotations),
  }));
}));
```
4. Grid re-renders only changed rows (React.memo per row, keyed by item.id + quantity + notes)

### Performance Mitigation

| Concern | Strategy |
|---|---|
| Grid re-renders on every polygon save | `useTakeoffRows()` slice only emits when item list or quantities actually change. `useShallow` prevents spurious rerenders from unrelated store changes. |
| Large grids (50+ items) | Unlikely in practice (most projects have 10-30 items). If needed, add `react-window` virtualization later. |
| Editing conflict (user mid-edit + quantity updates) | Editing state is local to the cell. Quantity column is read-only. No conflict. |
| Debounce on name/notes edits | 500ms debounce before PUT (same pattern as existing TakeoffPanel inline edit) |

---

## UI Components

### `TakeoffCsvPanel.tsx` (NEW, ~180 LOC)

Panel shell with:
- Header: title, dock/undock toggle, close button
- EditableGrid (reuse existing component)
- Footer: "+ Add Item" button, summary row (total items, total area/length/count)

When undocked: wraps in a `<DraggableWindow>` component.

### `DraggableWindow.tsx` (NEW, ~80 LOC)

Generic draggable/resizable floating container:
- Title bar (mousedown → drag)
- 4 corner resize handles (mousedown → resize)
- State: `{ x, y, width, height }` in local state
- Min size: 400×300, max: viewport
- CSS: `position: fixed; z-index: 45;` (below modals at z-50)
- Persists position in sessionStorage so it stays where user left it

### Modifications to Existing

**EditableGrid.tsx** — add:
- `onRowDelete?: (rowIndex: number) => void` callback
- `onRowAdd?: (data: Partial<Row>) => void` callback
- Delete button column (trash icon, rightmost)
- "+" row at bottom when `onRowAdd` provided

**ViewerToolbar.tsx** — add CSV panel toggle:
- New button or add to existing QTO button dropdown
- Icon: grid/spreadsheet icon

**viewerStore.ts** — add:
```typescript
showCsvPanel: boolean;
csvPanelDocked: boolean;
toggleCsvPanel: () => void;
setCsvPanelDocked: (docked: boolean) => void;
```

---

## File List

| File | Action | LOC |
|---|---|---|
| `src/components/viewer/TakeoffCsvPanel.tsx` | NEW | ~180 |
| `src/components/viewer/DraggableWindow.tsx` | NEW | ~80 |
| `src/components/viewer/EditableGrid.tsx` | EDIT | +30 (delete/add row) |
| `src/stores/viewerStore.ts` | EDIT | +6 (panel state) |
| `src/components/viewer/ViewerToolbar.tsx` | EDIT | +10 (toggle button) |
| `src/components/viewer/PDFViewer.tsx` | EDIT | +15 (render panel/window) |
| **Total** | | ~320 |

---

## Implementation Order

1. `DraggableWindow.tsx` — generic component, test standalone
2. `TakeoffCsvPanel.tsx` — shell with EditableGrid, read-only first
3. Wire to viewerStore — toggle button, dock/undock state
4. EditableGrid row delete — confirmation + API delete
5. EditableGrid row add — inline form + API create
6. Real-time quantity updates — `useTakeoffRows()` derived slice
7. Inline editing — name, notes, color (500ms debounced PUT)
8. Polish: persist position in sessionStorage, keyboard shortcuts

---

## Verification

1. Toggle CSV panel from toolbar → docked panel appears on right
2. Click undock → panel becomes floating window, draggable by title bar
3. Resize from corner handles → grid adjusts
4. Draw a polygon while panel is open → quantity updates in real-time
5. Edit item name inline → debounced save, no flicker
6. Delete a row → confirmation → item + all annotations removed
7. Add a row → new item created, auto-activated for drawing
8. Close and reopen → panel remembers docked/undocked state and position
