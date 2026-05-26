# Lazy Shell Drawer & Project Reordering

Date: 2026-05-03
Status: Approved (pending implementation plan)

## Summary

Two independent UX changes to Dash:

1. **Lazy shell drawer.** The bottom-right shell terminal in `TerminalDrawer` no longer spawns a PTY automatically when a task is selected. The shell process only starts when the user expands the drawer, and is killed when the drawer is collapsed. Per-task open state lives in renderer memory (not localStorage), so it resets across app reloads.
2. **Drag-and-drop project reordering.** Projects in the expanded left sidebar can be reordered by dragging. Order persists in SQLite via a new `display_order` column on the `projects` table, mirroring the existing pattern on `conversations`.

Tasks within projects are not reorderable. Drag is only supported in the expanded sidebar, not the collapsed icon-only mode.

## Motivation

- **Shell drawer.** Today, `TerminalDrawer` calls `sessionRegistry.getOrCreate(...)` on mount. Selecting any task immediately spawns a shell PTY, even if the user never uses it. This wastes processes and adds startup work to every task switch.
- **Project ordering.** Projects currently sort by insertion order with no way to reorganize. Users with many projects want manual control over where each project sits in the sidebar.

## Feature 1: Lazy shell drawer

### Current behavior

`TerminalDrawer` (`src/renderer/components/TerminalDrawer.tsx:48-68`):

- On mount, calls `sessionRegistry.getOrCreate({ id: shellId, cwd, shellOnly: true })`, which spawns a PTY immediately.
- Container element stays in the DOM with `height: 0` while collapsed (line 113-117) so reattach is avoided on expand.
- Session lifecycle is tied to component mount/unmount only.

`ShellDrawerWrapper` (`src/renderer/components/ShellDrawerWrapper.tsx`):

- Wraps the children in a vertical `PanelGroup` with the drawer below.
- Always mounts `TerminalDrawer` when `enabled && taskId && cwd` are truthy.
- Has a single global `collapsed` state owned by `App.tsx` (`shellDrawerCollapsed`), persisted to localStorage.

`App.tsx` state:

- `shellDrawerEnabled` (localStorage) — feature toggle.
- `shellDrawerCollapsed` (localStorage) — single shared collapsed flag.
- `shellDrawerPosition` ('left' | 'main' | 'right', localStorage).

### New behavior

- A task's shell drawer is **closed by default** the first time you select it.
- Clicking the collapsed header (or pressing the existing keybinding) **opens** the drawer; this triggers PTY creation.
- Clicking the expand-collapse chevron while open **closes** the drawer and **kills the PTY**.
- The per-task open/closed flag is held in a `Set<string>` of task IDs in `App.tsx` state. Toggling the chevron mutates the set for the active task. Switching tasks does not touch the set.
- When the active task changes, the previously-mounted `TerminalDrawer` for the old task unmounts (because `key={taskId}` changes). Its cleanup effect calls `sessionRegistry.dispose(shellId)`, which kills that task's PTY. Returning to that task later finds the task ID still in `openShellTaskIds`, so the drawer mounts again and spawns a **fresh** PTY — the previous shell state is gone (this matches the "kill on collapse" model).
- **In-memory only** — no localStorage for `openShellTaskIds`. App reload starts every task closed.
- The localStorage keys `shellDrawerCollapsed` is removed. `shellDrawerEnabled` and `shellDrawerPosition` remain.

### Renderer changes

**`App.tsx`:**

- Remove the `shellDrawerCollapsed` state and its localStorage hooks.
- Add `const [openShellTaskIds, setOpenShellTaskIds] = useState<Set<string>>(new Set())`.
- Replace the existing `collapsed`/`onCollapse`/`onExpand` props passed to `ShellDrawerWrapper` with derived values for the active task: `collapsed = !openShellTaskIds.has(activeTaskId)`, `onExpand` adds to set, `onCollapse` removes from set and disposes the session.
- Drop the `useEffect` that syncs the imperative panel ref with `shellDrawerCollapsed` (lines ~512–521); the `Panel`'s `defaultSize` and the new mount-on-open pattern handle this.

**`ShellDrawerWrapper.tsx`:**

- Only mount `TerminalDrawer` when the drawer is open (i.e., `!collapsed`). When closed, render the collapsed header button directly inside the `Panel` so the user can click to open. The `Panel` stays at `collapsedSize=3` like today.
- Keep `panelRef`, animation, and resize behavior unchanged.

**`TerminalDrawer.tsx`:**

- The component is now only rendered when open. Remove the "container always in DOM at height 0" pattern.
- `sessionRegistry.getOrCreate(...)` runs on mount, which now corresponds to "user just opened this drawer". This still triggers PTY creation as the side effect.
- On unmount (i.e., user collapsed the drawer or switched tasks), call a new `sessionRegistry.dispose(shellId)` instead of `detach`, which kills the PTY and removes the entry from the registry.
- The `collapsed` prop and the collapsed-state UI block are removed from this component. The collapsed UI now lives in `ShellDrawerWrapper`.

**`SessionRegistry.ts`:**

- Add a `dispose(id: string): void` method that:
  - Calls `pty:kill` IPC for the underlying PTY (if shell-only) so the OS process actually exits.
  - Disposes the xterm instance and addons.
  - Deletes the entry from the registry map.
- `detach` remains for the main Claude terminal lifecycle (which is unchanged).

### Out of scope

- Main Claude terminal (`TerminalPane`) lifecycle. Unchanged.
- Persistent per-task state across reloads.
- A separate "kill" button distinct from "collapse". The collapse chevron is the kill action.

## Feature 2: Drag-and-drop project reordering

### Schema change

Add `display_order` to the `projects` table:

```ts
// src/main/db/schema.ts
export const projects = sqliteTable('projects', {
  // …existing columns…
  displayOrder: integer('display_order').notNull().default(0),
  // …timestamps…
});
```

Migration: backfill existing rows by `created_at ASC` so first-created projects get the smallest values, preserving today's order.

`getProjects` returns rows sorted by `display_order ASC, created_at ASC` (the secondary sort handles ties from the default value).

### IPC

New handler in `dbIpc`:

```ts
// db:reorderProjects
async (orderedIds: string[]): IpcResponse<void>
```

- Wraps a single SQLite transaction.
- For each `id` at index `i`, sets `display_order = i`.
- IDs not in the array are left unchanged (UI always sends the full set).
- Returns success/error.

`window.electronAPI.reorderProjects(orderedIds)` is added to the preload bridge and the `electron-api.d.ts` type.

### Renderer

**`LeftSidebar.tsx`:**

- Each project row gets `draggable={true}`.
- Drag handlers on the row:
  - `onDragStart(e)` — set `e.dataTransfer.setData('application/x-dash-project-id', project.id)` and `effectAllowed = 'move'`. Set a "dragging" visual class on the source row.
  - `onDragEnd` — clear dragging class.
  - `onDragOver(e)` — `e.preventDefault()`, compute insertion side (above/below) from `e.clientY` relative to the row's bounding rect midpoint, set local "drop indicator" state for that row + side.
  - `onDragLeave` — clear drop indicator if the leave is to outside the row.
  - `onDrop(e)` — read the dragged ID, splice it out of the current `projects` array, insert at the computed index, call a new `onReorderProjects(orderedIds: string[])` prop with the new full ID list. Clear drop indicator.
- Drop indicator: a 2px horizontal bar absolutely positioned above or below the row using a Tailwind `bg-primary` class.
- Existing button click handlers (settings, commit graph, new task, delete) keep working — drag only fires when the user actually moves the row, and clicks on buttons stop propagation as today.
- Drag is supported only in the expanded sidebar branch. The collapsed-sidebar branch (icon mode, lines ~100–175) is unchanged.

**`App.tsx`:**

- `loadProjects` already sorts by what the DB returns; with the new `ORDER BY` it gets the right order.
- New `reorderProjects(orderedIds: string[])` handler that calls `window.electronAPI.reorderProjects(...)` and then updates local `projects` state by mapping IDs to objects in the new order. On error, toast and refetch.
- Pass `onReorderProjects={reorderProjects}` to `LeftSidebar`.

### Out of scope

- Reordering tasks within a project.
- Reordering projects in collapsed-sidebar mode.
- Multi-select drag.
- Cross-window drag.

## Data flow summary

**Shell drawer open:**

```
user clicks collapsed header
  → ShellDrawerWrapper raises onExpand
  → App.openShellTaskIds.add(activeTaskId)
  → ShellDrawerWrapper now mounts TerminalDrawer
  → TerminalDrawer useEffect → sessionRegistry.getOrCreate({ shellOnly: true })
  → main process spawns PTY, returns ptyId
  → xterm attaches, user sees prompt
```

**Shell drawer close:**

```
user clicks expand chevron
  → ShellDrawerWrapper raises onCollapse
  → App.openShellTaskIds.delete(activeTaskId)
  → TerminalDrawer unmounts
  → cleanup effect → sessionRegistry.dispose(shellId)
  → IPC pty:kill → main kills the PTY process
  → registry entry removed
```

**Project reorder:**

```
user drops project at new position
  → LeftSidebar computes new orderedIds[]
  → App.reorderProjects(orderedIds)
  → IPC db:reorderProjects → SQLite transaction sets display_order = index
  → success → setProjects(reordered)
  → on error → toast + refetch from DB
```

## Testing notes

Manual verification (per CLAUDE.md, UI tasks need browser testing):

1. **Shell drawer.** Select a task with the drawer feature enabled. Verify no shell PTY is created (check process list / no terminal data). Click the collapsed header → terminal mounts and shell prompt appears. Click chevron to collapse → confirm PTY died (e.g., the `ps` listing no longer shows the shell). Switch tasks → drawer is collapsed; opening it spawns a fresh shell. Reload app → all drawers collapsed.
2. **Project reorder.** Drag project B above project A → order updates immediately and persists across reload. Drag a project onto itself → no-op. Drag with a single project → works (no movement). Drag while sidebar is collapsed → not draggable. Click a project's settings/delete buttons after a drag operation → still works.

## Risks

- **PTY cleanup races.** If `dispose` runs while shell output is still buffered, we might log an EIO. Verify `pty:kill` already drains gracefully (it does — see `ptyManager`); add a try/catch around the IPC call to be safe.
- **Drop on archived task list.** Drag handlers should be scoped to project rows only. Archived tasks render in the same component but inside a separate sub-tree, so they should not match the project drag selectors.
- **DB migration on existing installs.** Backfilling `display_order` from `created_at` is one-shot; subsequent inserts default to 0 and would all collide. New project insertion should set `display_order = (SELECT COALESCE(MAX(display_order), -1) + 1 FROM projects)`.
