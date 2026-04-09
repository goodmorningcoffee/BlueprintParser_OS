# Part D — Takeoff Projects (Grouping Layer)

## SESSION COMPLETE (2026-04-05)

**Status: ALL 10 steps done, type-clean (npx tsc --noEmit = exit 0).**

- [x] D1 Schema + migration (schema.ts + drizzle/0020_add_takeoff_groups.sql)
- [x] D2 Types (TakeoffGroup, TakeoffGroupKind, ClientTakeoffItem.groupId)
- [x] D3 API endpoints (takeoff-groups CRUD + item groupId + project hydration fix — also fixed pre-existing bug where size/notes weren't returned from project GET)
- [x] D4 Store state (takeoffGroups + actions + reset)
- [x] D5 Hydrate on project load (dashboard page only; demo page doesn't hydrate takeoffItems from DB)
- [x] D6 `src/components/viewer/TakeoffGroupSection.tsx` — collapsible group header, color swatch, rename-on-double-click, delete-with-confirm, per-item "Move to" dropdown (file-icon button with outside-click backdrop)
- [x] D7 `CountTab.tsx` — byGroup/ungrouped split, `+ New Group` form, `countGroups` filter, `renderCountItem` callback, preserves TakeoffEditPanel + add-item form + totalCount footer
- [x] D7b `AreaTab.tsx` — same pattern with `areaGroups`, keeps ScaleStatus + anyMissingCalibration footer
- [x] D7c `LinearTab.tsx` — same pattern with `linearGroups`, dropped unused `computePixelsPerUnit`/`LinearPolylineData` imports
- [x] D-final `npx tsc --noEmit` → exit 0

**DEPLOY:** Just run `./deploy.sh`. Migration 0020 auto-applies via `entrypoint.sh` (calls Drizzle's `migrate()` at container start).

---

## Context

Currently, takeoff items in `takeoff_items` are a **flat list** scoped to a project. Users creating 50+ items per project (realistic for a commercial project) cannot organize them by CSI division, trade, or any other bucket. The three tabs (Count / Area / Linear) each just render a flat filtered list.

**User's request:** Add a "Takeoff Project" grouping layer *inside* each tab so users can organize by division ("Division 08 — Openings"), CSI code, or freeform labels. Groups live under each tab independently — Count-groups for count items, Area-groups for area items, Linear-groups for linear items.

**Why a new layer (not reuse existing `projects` table):** The existing `projects` table is the blueprint/drawing-set project. We need a subdivision *inside* that project for organizing takeoff items. Calling it a "takeoff_group" avoids naming collision; users can call them "Takeoff Projects" in the UI.

---

## Design Decisions

### D0.1 Flat groups, not nested
Users asked for organization by division/CSI — a single hierarchy layer covers that. Nested groups (folders within folders) would be over-engineering for v1.

### D0.2 Groups are kind-scoped
A group's `kind` (count/area/linear) matches the tab it lives in. A count-group can only contain count items. This keeps the three tabs visually and logically clean. Auto-QTO groups (kind="qto") are NOT part of v1 scope — Auto-QTO workflows stay in their own tab unchanged.

### D0.3 Nullable `groupId` on takeoff_items
Existing items stay ungrouped (NULL). Each tab shows an "Ungrouped" section at the top plus any groups. No data migration needed.

### D0.4 Session-ephemeral groups in demo mode
Same pattern as takeoff items: negative IDs, no API, lost on refresh.

### D0.5 Groups loaded at project hydration (not lazy)
Fetched alongside `takeoffItems` from `/api/projects/[id]` on page load. Avoids an extra round-trip and a loading flash in tabs.

---

## Critical Files Reference

```
src/lib/db/schema.ts                                 — add takeoffGroups table + groupId col
src/types/index.ts                                   — TakeoffGroup type, ClientTakeoffItem.groupId
src/stores/viewerStore.ts                            — takeoffGroups state + actions
src/app/api/takeoff-groups/route.ts                  — NEW (GET list + POST create)
src/app/api/takeoff-groups/[id]/route.ts             — NEW (PUT + DELETE)
src/app/api/takeoff-items/route.ts                   — accept groupId on POST
src/app/api/takeoff-items/[id]/route.ts              — accept groupId on PUT
src/app/api/projects/[id]/route.ts                   — return takeoffGroups in hydration
src/app/(dashboard)/project/[id]/page.tsx            — hydrate setTakeoffGroups
src/app/demo/project/[id]/page.tsx                   — hydrate setTakeoffGroups
src/components/viewer/CountTab.tsx                   — grouped list UI
src/components/viewer/AreaTab.tsx                    — grouped list UI
src/components/viewer/LinearTab.tsx                  — grouped list UI
src/components/viewer/TakeoffGroupSection.tsx        — NEW shared component
drizzle/0020_add_takeoff_groups.sql                  — NEW migration
```

---

## D1. DB Schema + Migration

### D1.1 `src/lib/db/schema.ts`

Add after `takeoffItems` definition:

```typescript
export const takeoffGroups = pgTable(
  "takeoff_groups",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull(), // "count" | "area" | "linear"
    color: varchar("color", { length: 20 }),
    csiCode: varchar("csi_code", { length: 20 }),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_takeoff_groups_project").on(table.projectId),
    index("idx_takeoff_groups_project_kind").on(table.projectId, table.kind),
  ]
);
```

**Modify existing `takeoffItems` table** (add one column):
```typescript
// In the takeoffItems column list:
groupId: integer("group_id").references(() => takeoffGroups.id, { onDelete: "set null" }),
```

### D1.2 `drizzle/0020_add_takeoff_groups.sql`

```sql
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS "takeoff_groups" (
    "id" serial PRIMARY KEY,
    "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
    "name" varchar(255) NOT NULL,
    "kind" varchar(20) NOT NULL,
    "color" varchar(20),
    "csi_code" varchar(20),
    "sort_order" integer NOT NULL DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now()
  );
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_takeoff_groups_project" ON "takeoff_groups" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_takeoff_groups_project_kind" ON "takeoff_groups" ("project_id", "kind");

ALTER TABLE "takeoff_items" ADD COLUMN IF NOT EXISTS "group_id" integer REFERENCES "takeoff_groups"("id") ON DELETE SET NULL;
```

Follow the `DO $$ BEGIN ... EXCEPTION WHEN duplicate_table` pattern from `0015_add_qto_workflows.sql`.

---

## D2. Types

**`src/types/index.ts`** — add after `ClientTakeoffItem`:

```typescript
export type TakeoffGroupKind = "count" | "area" | "linear";

export interface TakeoffGroup {
  id: number;
  name: string;
  kind: TakeoffGroupKind;
  color: string | null;
  csiCode: string | null;
  sortOrder: number;
}
```

**Extend `ClientTakeoffItem`**:
```typescript
export interface ClientTakeoffItem {
  id: number;
  name: string;
  shape: TakeoffItemShape;
  color: string;
  size: number;
  notes?: string;
  sortOrder: number;
  groupId?: number | null;   // NEW
}
```

---

## D3. API Endpoints

### D3.1 `src/app/api/takeoff-groups/route.ts` (NEW)

Pattern: match `src/app/api/takeoff-items/route.ts`. Auth via `requireAuth()`, verify company ownership.

- **GET** `?projectId=<publicId>` → list all groups, ordered by `sortOrder`
- **POST** body: `{ projectId, name, kind, color?, csiCode? }`
  - Validate `kind ∈ {"count","area","linear"}`
  - Validate `name.trim().length > 0 && name.length <= 255`
  - Compute next `sortOrder` via `MAX(sort_order) + 1` scoped to `(projectId, kind)`
  - Return new group row

### D3.2 `src/app/api/takeoff-groups/[id]/route.ts` (NEW)

- **PUT** body: `{ name?, color?, csiCode?, sortOrder? }` — partial update
  - Fetch group, verify company ownership via project FK
  - Validate name length, csiCode length (≤ 20)
- **DELETE**
  - Fetch group, verify company ownership
  - Single DELETE — FK `ON DELETE SET NULL` on `takeoff_items.group_id` handles orphaning automatically

### D3.3 Extend `src/app/api/takeoff-items/[id]/route.ts:42-48` (PUT)

```typescript
if (body.groupId !== undefined) {
  // Validate groupId is null or a valid int; FK constraint catches bad values
  if (body.groupId !== null && !Number.isInteger(body.groupId)) {
    return NextResponse.json({ error: "invalid groupId" }, { status: 400 });
  }
  updates.groupId = body.groupId;
}
```

### D3.4 Extend `src/app/api/takeoff-items/route.ts` (POST)

Accept optional `groupId` in request body, include in the insert values.

### D3.5 Extend `src/app/api/projects/[id]/route.ts:77-83` (project hydration)

**Also fix pre-existing bug**: the current response omits `size`, `notes`, and (new) `groupId`:

```typescript
takeoffItems: projectTakeoffItems.map((t) => ({
  id: t.id,
  name: t.name,
  shape: t.shape,
  color: t.color,
  size: t.size,          // NEW (was missing — notes field from CSV modal wouldn't load)
  notes: t.notes,        // NEW (was missing)
  sortOrder: t.sortOrder,
  groupId: t.groupId,    // NEW
})),
```

Also add after the takeoffItems query:
```typescript
const projectTakeoffGroups = await db
  .select()
  .from(takeoffGroups)
  .where(eq(takeoffGroups.projectId, project.id))
  .orderBy(takeoffGroups.sortOrder);

// Include in response:
takeoffGroups: projectTakeoffGroups.map((g) => ({
  id: g.id,
  name: g.name,
  kind: g.kind,
  color: g.color,
  csiCode: g.csiCode,
  sortOrder: g.sortOrder,
})),
```

---

## D4. Store State

**`src/stores/viewerStore.ts`** — add to state interface (line ~210 alongside takeoffItems):

```typescript
takeoffGroups: TakeoffGroup[];
setTakeoffGroups: (groups: TakeoffGroup[]) => void;
addTakeoffGroup: (g: TakeoffGroup) => void;
removeTakeoffGroup: (id: number) => void;
updateTakeoffGroup: (id: number, updates: Partial<TakeoffGroup>) => void;
```

In the store factory:
```typescript
takeoffGroups: [],
setTakeoffGroups: (takeoffGroups) => set({ takeoffGroups }),
addTakeoffGroup: (g) => set((s) => ({ takeoffGroups: [...s.takeoffGroups, g] })),
removeTakeoffGroup: (id) =>
  set((s) => ({
    takeoffGroups: s.takeoffGroups.filter((g) => g.id !== id),
    // Also ungroup items that belonged to the deleted group (client-side mirror of FK SET NULL)
    takeoffItems: s.takeoffItems.map((t) => (t.groupId === id ? { ...t, groupId: null } : t)),
  })),
updateTakeoffGroup: (id, updates) =>
  set((s) => ({
    takeoffGroups: s.takeoffGroups.map((g) => (g.id === id ? { ...g, ...updates } : g)),
  })),
```

**Reset** (line 942) — add `takeoffGroups: []` to `resetProjectData()`.

---

## D5. Project Load Hydration

**`src/app/(dashboard)/project/[id]/page.tsx` (line 149)** — after `setTakeoffItems(data.takeoffItems)`:

```typescript
if (data.takeoffGroups) setTakeoffGroups(data.takeoffGroups);
```

Same for `src/app/demo/project/[id]/page.tsx`.

Add `setTakeoffGroups` to the `useViewerStore` selector list at the top of each page.

---

## D6. Shared UI Component: `TakeoffGroupSection.tsx`

**New file:** `src/components/viewer/TakeoffGroupSection.tsx`

Renders a single collapsible group with its items. Used by CountTab/AreaTab/LinearTab.

**Props:**
```typescript
interface TakeoffGroupSectionProps {
  group: TakeoffGroup | null;  // null = "Ungrouped" virtual section
  kind: TakeoffGroupKind;
  items: ClientTakeoffItem[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onRename?: (newName: string) => void;      // undefined for Ungrouped
  onDelete?: () => void;                      // undefined for Ungrouped
  onMoveItem: (itemId: number, targetGroupId: number | null) => void;
  renderItem: (item: ClientTakeoffItem) => React.ReactNode;  // tab-specific row renderer
  availableGroups: TakeoffGroup[];            // for "Move to..." dropdown
}
```

**Behavior:**
- Header row: chevron ▼/▶, group name (double-click to rename), item count, delete button
- Hidden when `items.length === 0 && group === null` (no ungrouped items to show)
- "Move to group..." dropdown inside each item action bar (passed down via `renderItem`)

**Why a shared component:** All three tabs render the same group chrome. Tab-specific logic stays in the `renderItem` callback.

---

## D7. Tab Refactor — CountTab (and parallel AreaTab / LinearTab)

Each tab gets the same restructure:

```tsx
// Before: flat .map() of items
// After:
const tabKind: TakeoffGroupKind = "count";
const tabGroups = takeoffGroups.filter((g) => g.kind === tabKind);
const ungrouped = countItems.filter((i) => !i.groupId);
const byGroup: Record<number, ClientTakeoffItem[]> = {};
for (const g of tabGroups) byGroup[g.id] = [];
for (const item of countItems) {
  if (item.groupId && byGroup[item.groupId]) byGroup[item.groupId].push(item);
}

return (
  <>
    {/* "+ New Group" button at top */}
    <button onClick={() => startCreateGroup()}>+ New Group</button>

    {/* Groups in sortOrder */}
    {tabGroups.map((g) => (
      <TakeoffGroupSection
        key={g.id}
        group={g}
        kind={tabKind}
        items={byGroup[g.id] || []}
        collapsed={collapsedMap[g.id] ?? false}
        onToggleCollapsed={() => toggleCollapsed(g.id)}
        onRename={(name) => renameGroup(g.id, name)}
        onDelete={() => deleteGroup(g.id)}
        onMoveItem={moveItemToGroup}
        renderItem={renderCountItem}
        availableGroups={tabGroups}
      />
    ))}

    {/* Ungrouped section */}
    {ungrouped.length > 0 && (
      <TakeoffGroupSection
        group={null}
        kind={tabKind}
        items={ungrouped}
        collapsed={collapsedMap["ungrouped"] ?? false}
        onToggleCollapsed={() => toggleCollapsed("ungrouped")}
        onMoveItem={moveItemToGroup}
        renderItem={renderCountItem}
        availableGroups={tabGroups}
      />
    )}

    {/* + Add Item button (unchanged, at bottom) */}
  </>
);
```

**`renderCountItem`** — keep the existing item row rendering (the big `<div>` at line 138-203 of CountTab.tsx) factored out into a local callback or small component.

**Move item flow:** Click small "folder" icon on item → dropdown shows existing groups + "Ungrouped" + "+ New Group". Selecting updates `groupId` via `updateTakeoffItem` + PUT to API.

**Create group flow:** Click "+ New Group" → inline input appears → on Enter, POST `/api/takeoff-groups` with `kind=tabKind` → append to store → clear input.

**Delete group flow:** Click X on group header → confirm dialog → DELETE `/api/takeoff-groups/[id]` → `removeTakeoffGroup(id)` in store (also ungroups items locally).

---

## D8. Demo Mode

Demo takeoff items use negative IDs (`id: -Date.now()`). Groups follow the same pattern. All group operations in demo mode are Zustand-only, no API calls.

Check `isDemo` in the tab handlers for create/rename/delete/move group and skip the `fetch`.

---

## D9. Out of Scope (v1)

- Drag-to-reorder items between groups (use "Move to..." dropdown instead)
- Drag-to-reorder groups themselves (sortOrder editable via group header menu later)
- Nested groups (groups inside groups)
- Group-level color application to all items (each item keeps its own color)
- Auto-QTO integration (QTO workflows stay in their own tab with workflow-based hierarchy)
- Bulk move (multi-select items + move)

---

## Build Order

1. **D1** — Schema + migration file + run migration on dev DB
2. **D2** — Types
3. **D3** — API endpoints (group CRUD + item groupId acceptance + project hydration fix)
4. **D4** — Store state + reset logic
5. **D5** — Project load hydration (both dashboard + demo pages)
6. **D6** — `TakeoffGroupSection.tsx` shared component
7. **D7** — Refactor CountTab → AreaTab → LinearTab (one at a time, test each)
8. **D8** — Demo mode verification
9. Type-check + deploy

Each step is independently verifiable. Schema + migration can deploy first; stack builds on top.

---

## Verification Plan

1. **Migration applies cleanly** on a DB with existing takeoff_items (no data loss).
2. **Create a group** "Division 08 - Openings" in Count tab → POST succeeds, appears in list.
3. **Create a count item** while a group is selected → item is created with that `groupId`, appears under group.
4. **Move existing item** via "Move to..." dropdown → PUT updates `groupId`, item jumps sections.
5. **Rename a group** via header double-click → PUT succeeds, name updates everywhere.
6. **Delete a group** with 3 items inside → group removed, items fall back to Ungrouped (FK cascade).
7. **Refresh page** → groups reload from API, items appear in the right sections.
8. **Demo mode** → create group, move items, refresh → groups gone (session-only), items stay ungrouped.
9. **Cross-tab isolation** → a Count group doesn't appear in Area tab; can't move area items to count groups.
10. **Delete project** → `takeoff_groups` cascade-delete (no orphan rows).

---

## Risks + Mitigations

| Risk | Mitigation |
|------|------------|
| Existing takeoff items get orphaned on migration | Nullable FK with `SET NULL` — items remain usable, just ungrouped |
| User confused about "takeoff project" vs blueprint "project" | Label it "Group" in UI; tooltip clarifies |
| Group kind mismatch (move count item to area group) | UI only shows same-kind groups in "Move to" dropdown |
| Demo mode groups leak across sessions | resetProjectData clears takeoffGroups |
| Performance: rendering 50 groups × 50 items | React key stability + memoize renderItem callbacks |
| Group color not applied to items (expectations gap) | v1 uses group color only for header tint; items keep individual colors |
