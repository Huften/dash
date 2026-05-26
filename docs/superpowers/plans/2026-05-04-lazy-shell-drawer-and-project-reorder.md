# Lazy Shell Drawer & Project Reordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bottom-right shell terminal lazy (spawn on first open, kill on collapse), and add HTML5 drag-and-drop project reordering to the left sidebar.

**Architecture:** Two independent UI/data changes in one branch. Shell drawer becomes ephemeral and per-task in-memory; project reordering adds a `display_order` column with a new IPC reorder endpoint. Spec: `docs/superpowers/specs/2026-05-03-lazy-shell-drawer-and-project-reorder-design.md`.

**Tech Stack:** Electron 30, React 18, xterm.js 5, better-sqlite3 + drizzle-orm, TypeScript. No test framework in this repo — verification is `pnpm type-check` + manual UI testing in the dev app (`pnpm dev`).

---

## File map

| File                                             | Change | Purpose                                                                                                                     |
| ------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/components/ShellDrawerWrapper.tsx` | Modify | Render the collapsed header itself; mount `TerminalDrawer` only when expanded                                               |
| `src/renderer/components/TerminalDrawer.tsx`     | Modify | Remove the collapsed-state branch and the always-in-DOM container; switch cleanup from `detach` to `dispose`                |
| `src/renderer/App.tsx`                           | Modify | Replace `shellDrawerCollapsed` (+ localStorage) with per-task `openShellTaskIds: Set<string>`; remove the panel-sync effect |
| `src/main/db/schema.ts`                          | Modify | Add `displayOrder` column to `projects`                                                                                     |
| `src/main/db/migrate.ts`                         | Modify | Add `display_order` column with backfill from `created_at`                                                                  |
| `src/main/services/DatabaseService.ts`           | Modify | Sort projects by `displayOrder, createdAt`; set next `displayOrder` on insert; add `reorderProjects`                        |
| `src/main/ipc/dbIpc.ts`                          | Modify | Add `db:reorderProjects` handler                                                                                            |
| `src/main/preload.ts`                            | Modify | Expose `reorderProjects`                                                                                                    |
| `src/types/electron-api.d.ts`                    | Modify | Add `reorderProjects` to `ElectronAPI`                                                                                      |
| `src/renderer/components/LeftSidebar.tsx`        | Modify | Add drag handlers + drop indicator on project rows; new `onReorderProjects` prop                                            |

---

## Feature 1: Lazy Shell Drawer

### Task 1: Restructure `ShellDrawerWrapper` to render the collapsed UI itself

**Files:**

- Modify: `src/renderer/components/ShellDrawerWrapper.tsx`

The wrapper currently always mounts `TerminalDrawer` and lets that component render either the collapsed header or the expanded terminal. We move the collapsed header into the wrapper so `TerminalDrawer` only mounts when the drawer is actually open.

- [ ] **Step 1: Replace the wrapper body**

Replace the entire file with:

```tsx
import React from 'react';
import { Terminal, ChevronUp } from 'lucide-react';
import {
  PanelGroup,
  Panel,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from 'react-resizable-panels';
import { TerminalDrawer } from './TerminalDrawer';

interface ShellDrawerWrapperProps {
  enabled: boolean;
  taskId: string | null;
  cwd: string | null;
  collapsed: boolean;
  label?: string;
  panelRef: React.RefObject<ImperativePanelHandle>;
  animating: boolean;
  onAnimate: () => void;
  onCollapse: () => void;
  onExpand: () => void;
  children: React.ReactNode;
}

export function ShellDrawerWrapper({
  enabled,
  taskId,
  cwd,
  collapsed,
  label = 'Terminal',
  panelRef,
  animating,
  onAnimate,
  onCollapse,
  onExpand,
  children,
}: ShellDrawerWrapperProps) {
  if (!enabled || !taskId || !cwd) {
    return <>{children}</>;
  }

  return (
    <PanelGroup direction="vertical" className="h-full">
      <Panel minSize={20}>{children}</Panel>
      <PanelResizeHandle disabled={collapsed} className="h-[1px] bg-border" />
      <Panel
        ref={panelRef}
        className={animating ? 'panel-transition' : ''}
        defaultSize={collapsed ? 3 : 45}
        minSize={8}
        maxSize={60}
        collapsible
        collapsedSize={3}
        onCollapse={onCollapse}
        onExpand={onExpand}
      >
        {collapsed ? (
          <button
            onClick={() => {
              onAnimate();
              panelRef.current?.expand();
            }}
            className="h-full w-full flex items-center gap-2 px-4 text-foreground/80 hover:text-foreground transition-colors"
            style={{ background: 'hsl(var(--surface-1))' }}
          >
            <Terminal size={12} strokeWidth={1.8} />
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em]">{label}</span>
            <ChevronUp size={12} strokeWidth={1.8} className="ml-auto" />
          </button>
        ) : (
          <TerminalDrawer
            key={taskId}
            taskId={taskId}
            cwd={cwd}
            label={label}
            onCollapse={() => {
              onAnimate();
              panelRef.current?.collapse();
            }}
          />
        )}
      </Panel>
    </PanelGroup>
  );
}
```

- [ ] **Step 2: Run `pnpm type-check`**

Run: `pnpm type-check`
Expected: failures in `TerminalDrawer.tsx` (props mismatch — we pass no `collapsed`/`onExpand`). That's fine — Task 2 fixes it. No new errors elsewhere.

- [ ] **Step 3: Do not commit yet** — Task 2 is the matching `TerminalDrawer` change.

---

### Task 2: Make `TerminalDrawer` expanded-only and dispose on unmount

**Files:**

- Modify: `src/renderer/components/TerminalDrawer.tsx`

`TerminalDrawer` no longer needs to render a collapsed state (its parent does that now). It also needs to **kill** the PTY on unmount, not just detach the xterm DOM. `sessionRegistry.dispose(id)` already exists and kills the underlying session via `session.dispose()` (see `SessionRegistry.ts:54-60`); we simply call it instead of `detach`.

- [ ] **Step 1: Replace the file contents**

```tsx
import React, { useRef, useEffect, useState } from 'react';
import { Terminal, ChevronDown } from 'lucide-react';
import { sessionRegistry } from '../terminal/SessionRegistry';

/**
 * Shorten a path for display: `[...]/parentOfInitial/current/sub/dirs`.
 * If the user navigates outside the initial tree, falls back to last 2 segments.
 */
function shortenCwd(current: string, initial: string): string {
  if (current === '/') return '/';
  const initialParts = initial.split('/');
  const grandparent = initialParts.slice(0, -2).join('/') || '/';
  const prefix = grandparent === '/' ? '/' : grandparent + '/';

  if (current.startsWith(prefix) && current.length > prefix.length) {
    return '[...] /' + current.slice(prefix.length);
  }

  const parts = current.split('/').filter(Boolean);
  if (parts.length === 0) return '/';
  if (parts.length <= 2) return '/' + parts.join('/');
  return '[...] /' + parts.slice(-2).join('/');
}

interface TerminalDrawerProps {
  taskId: string;
  cwd: string;
  label?: string;
  onCollapse: () => void;
}

export function TerminalDrawer({
  taskId,
  cwd,
  label = 'Terminal',
  onCollapse,
}: TerminalDrawerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shellId = `shell:${taskId}`;
  const [displayCwd, setDisplayCwd] = useState(cwd);

  useEffect(() => {
    setDisplayCwd(cwd);
  }, [cwd]);

  // Spawn shell on mount, dispose (kill PTY) on unmount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const session = sessionRegistry.getOrCreate({
      id: shellId,
      cwd,
      shellOnly: true,
    });
    session.attach(container);
    requestAnimationFrame(() => session.focus());

    setDisplayCwd(session.currentCwd);
    session.onCwdChange((newCwd) => setDisplayCwd(newCwd));

    return () => {
      // Fire-and-forget; dispose kills the PTY and removes the session.
      void sessionRegistry.dispose(shellId);
    };
  }, [shellId, cwd]);

  return (
    <div className="h-full flex flex-col">
      <div
        className="flex items-center gap-2 px-3 h-8 flex-shrink-0 border-b border-border/40"
        style={{ background: 'hsl(var(--surface-1))' }}
      >
        <Terminal size={12} strokeWidth={1.8} className="text-foreground/80" />
        <span className="text-[11px] font-semibold uppercase text-foreground/80 tracking-[0.08em]">
          {label}
        </span>
        <span className="text-[11px] font-mono text-muted-foreground/50 truncate flex-1">
          {shortenCwd(displayCwd, cwd)}
        </span>
        <button
          onClick={onCollapse}
          className="p-1 rounded hover:bg-accent text-muted-foreground/40 hover:text-foreground transition-colors"
        >
          <ChevronDown size={12} strokeWidth={2} />
        </button>
      </div>
      <div ref={containerRef} className="terminal-container flex-1 min-h-0" />
    </div>
  );
}
```

- [ ] **Step 2: Run `pnpm type-check`**

Run: `pnpm type-check`
Expected: passes for both files now. App.tsx may still surface unrelated errors that get fixed in Task 3 (the `shellDrawerCollapsed` removal). If you see errors not related to `shellDrawerCollapsed` or `openShellTaskIds`, stop and investigate.

- [ ] **Step 3: Do not commit yet** — Task 3 is the matching App.tsx change.

---

### Task 3: Replace `shellDrawerCollapsed` with per-task `openShellTaskIds` in `App.tsx`

**Files:**

- Modify: `src/renderer/App.tsx` (lines around 84-92, 144-147, 512-521, 1004-1155, 1215-1223)

Per the spec, drawer open state is now per-task and in-memory. The single global `shellDrawerCollapsed` flag (and its localStorage entry) goes away. The active task's open flag drives the `collapsed` prop on each of the three `ShellDrawerWrapper` instances.

- [ ] **Step 1: Replace the `shellDrawerCollapsed` state declaration**

Find the existing block (around lines 84-92):

```tsx
const [shellDrawerEnabled, setShellDrawerEnabled] = useState(() => {
  const stored = localStorage.getItem('shellDrawerEnabled');
  // …existing default…
});
const [shellDrawerCollapsed, setShellDrawerCollapsed] = useState(() => {
  return localStorage.getItem('shellDrawerCollapsed') === 'true';
});
const [shellDrawerPosition, setShellDrawerPosition] = useState<'left' | 'main' | 'right'>(() => {
  return (localStorage.getItem('shellDrawerPosition') as 'left' | 'main' | 'right') || 'right';
});
```

Remove the `shellDrawerCollapsed` block entirely. The remaining two stay. Immediately below them, add:

```tsx
// Per-task in-memory shell drawer open flag. Reset every app reload.
const [openShellTaskIds, setOpenShellTaskIds] = useState<Set<string>>(new Set());

const shellDrawerOpen = activeTaskId ? openShellTaskIds.has(activeTaskId) : false;

function openShellDrawer() {
  if (!activeTaskId) return;
  setOpenShellTaskIds((prev) => {
    if (prev.has(activeTaskId)) return prev;
    const next = new Set(prev);
    next.add(activeTaskId);
    return next;
  });
}

function closeShellDrawer() {
  if (!activeTaskId) return;
  setOpenShellTaskIds((prev) => {
    if (!prev.has(activeTaskId)) return prev;
    const next = new Set(prev);
    next.delete(activeTaskId);
    return next;
  });
}
```

(`activeTaskId` is already in scope — it's the existing piece of state used by every `ShellDrawerWrapper` call site.)

- [ ] **Step 2: Re-key the panel-sync `useEffect` to `shellDrawerOpen`**

Find the block around lines 512-521:

```tsx
useEffect(() => {
  if (!shellDrawerEnabled) return;
  const panel = shellDrawerPanelRef.current;
  if (!panel) return;
  if (shellDrawerCollapsed) {
    panel.collapse();
  } else {
    panel.expand();
  }
}, [shellDrawerEnabled, shellDrawerCollapsed]);
```

Replace with:

```tsx
// When the active task changes, the derived shellDrawerOpen value flips.
// react-resizable-panels does not re-apply defaultSize on prop change, so
// we drive collapse/expand imperatively. The user-driven button clicks in
// ShellDrawerWrapper also call panelRef.expand()/collapse() directly; this
// effect is the safety net for state-driven changes (task switch).
useEffect(() => {
  if (!shellDrawerEnabled) return;
  const panel = shellDrawerPanelRef.current;
  if (!panel) return;
  if (shellDrawerOpen) {
    panel.expand();
  } else {
    panel.collapse();
  }
}, [shellDrawerEnabled, shellDrawerOpen]);
```

- [ ] **Step 3: Update each `<ShellDrawerWrapper>` call site**

There are three (left position, main position, right position — around lines 1004, 1062, 1119). For each one, change the `collapsed`/`onCollapse`/`onExpand` props.

Old (each instance has its own copy of this pattern):

```tsx
            collapsed={shellDrawerCollapsed}
            …
            onCollapse={() => {
              setShellDrawerCollapsed(true);
              localStorage.setItem('shellDrawerCollapsed', 'true');
            }}
            onExpand={() => {
              setShellDrawerCollapsed(false);
              localStorage.setItem('shellDrawerCollapsed', 'false');
            }}
```

New (use the same replacement at all three sites):

```tsx
            collapsed={!shellDrawerOpen}
            …
            onCollapse={closeShellDrawer}
            onExpand={openShellDrawer}
```

Leave `enabled`, `taskId`, `cwd`, `label`, `panelRef`, `animating`, `onAnimate`, and `children` as they are.

- [ ] **Step 4: Update the `SettingsModal` props block**

Find the block around lines 1215-1223 where `shellDrawerEnabled` etc. get passed. Leave `shellDrawerEnabled` and `shellDrawerPosition` props alone — they are unrelated.

- [ ] **Step 5: Run `pnpm type-check`**

Run: `pnpm type-check`
Expected: PASS with no errors.

- [ ] **Step 6: Manual smoke test**

Run: `pnpm dev`

Verify:

1. Select a task. The bottom shell drawer is collapsed by default (no terminal visible).
2. **Critical:** verify no shell PTY was spawned. On macOS/Linux: `pgrep -af 'shell:'` — but Dash sends shells via `pty:start` not by process name, so easier check is to expand and watch the new terminal initialize from scratch.
3. Click the collapsed header. Drawer animates open, a fresh shell prompt appears.
4. Type `echo hello`. Click the chevron to collapse. Re-expand. Verify the new shell does NOT have `hello` in scrollback (PTY was killed and respawned).
5. Switch to a different task. Drawer is collapsed. Open it. Switch back to the first task. Drawer is open (auto, because the task ID was still in `openShellTaskIds`) but the shell is freshly spawned.
6. Reload the app (Cmd/Ctrl+R). All drawers are closed.

If anything fails, stop and fix before committing.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/ShellDrawerWrapper.tsx src/renderer/components/TerminalDrawer.tsx src/renderer/App.tsx
git commit -m "Make shell drawer lazy and per-task

The bottom-right shell PTY now spawns only when the user expands the
drawer for that task, and is killed on collapse. Open state is in-memory
per task ID; app reload starts every task closed."
```

---

## Feature 2: Project Reordering

### Task 4: Add `display_order` column to `projects` table

**Files:**

- Modify: `src/main/db/schema.ts`
- Modify: `src/main/db/migrate.ts`

- [ ] **Step 1: Add the column to the Drizzle schema**

In `src/main/db/schema.ts`, change the `projects` table definition. Find:

```ts
export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    gitRemote: text('git_remote'),
    gitBranch: text('git_branch'),
    baseRef: text('base_ref'),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  },
```

Replace with:

```ts
export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    gitRemote: text('git_remote'),
    gitBranch: text('git_branch'),
    baseRef: text('base_ref'),
    displayOrder: integer('display_order').notNull().default(0),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  },
```

- [ ] **Step 2: Add migration in `migrate.ts`**

In `src/main/db/migrate.ts`, the file already follows the pattern of `try { rawDb.exec(ALTER TABLE …) } catch { /* already exists */ }` for new columns. Add the new column with a backfill — the backfill must run **only once** to avoid wiping user-set order on every startup.

Find the section that has the `try { rawDb.exec("ALTER TABLE tasks ADD COLUMN linked_branch_created_by_dash …") } catch ...` block (around lines 128-132). Right after it (but still before `rawDb.pragma('foreign_keys = ON')`), insert:

```ts
// Add display_order to projects with one-time backfill from created_at.
let projectsDisplayOrderJustAdded = false;
try {
  rawDb.exec(`ALTER TABLE projects ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0`);
  projectsDisplayOrderJustAdded = true;
} catch {
  /* already exists */
}
if (projectsDisplayOrderJustAdded) {
  const rows = rawDb.prepare(`SELECT id FROM projects ORDER BY created_at ASC, id ASC`).all() as {
    id: string;
  }[];
  const update = rawDb.prepare(`UPDATE projects SET display_order = ? WHERE id = ?`);
  const tx = rawDb.transaction((items: { id: string }[]) => {
    items.forEach((row, i) => update.run(i, row.id));
  });
  tx(rows);
}
```

- [ ] **Step 3: Run `pnpm type-check`**

Run: `pnpm type-check`
Expected: PASS.

- [ ] **Step 4: Do not commit yet** — Task 5 needs the schema change to compile.

---

### Task 5: `DatabaseService` — sort, reorder, and assign new project order

**Files:**

- Modify: `src/main/services/DatabaseService.ts`

- [ ] **Step 1: Order `getProjects` by display_order then created_at**

Find:

```ts
  static getProjects(): Project[] {
    const db = getDb();
    const rows = db.select().from(projects).all();
    return rows.map(this.mapProject);
  }
```

Replace with:

```ts
  static getProjects(): Project[] {
    const db = getDb();
    const rows = db
      .select()
      .from(projects)
      .orderBy(asc(projects.displayOrder), asc(projects.createdAt))
      .all();
    return rows.map(this.mapProject);
  }
```

- [ ] **Step 2: Add `asc` to the drizzle-orm import**

Find at the top of the file:

```ts
import { eq, desc, and, isNull } from 'drizzle-orm';
```

Replace with:

```ts
import { eq, desc, and, isNull, asc, sql } from 'drizzle-orm';
```

(`sql` is needed in Step 4.)

- [ ] **Step 3: Set `display_order` on new project insert**

Find the `saveProject` insert block:

```ts
    db.insert(projects)
      .values({
        id,
        name: data.name,
        path: data.path,
        gitRemote: data.gitRemote ?? null,
        gitBranch: data.gitBranch ?? null,
        baseRef: data.baseRef ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
```

Replace with (compute next order before the insert; only used on insert path — the `onConflictDoUpdate` `set` clause does NOT include `displayOrder`, so reorders survive an upsert):

```ts
    const nextOrderRow = db
      .select({ max: sql<number | null>`MAX(${projects.displayOrder})` })
      .from(projects)
      .all()[0];
    const nextDisplayOrder = (nextOrderRow?.max ?? -1) + 1;

    db.insert(projects)
      .values({
        id,
        name: data.name,
        path: data.path,
        gitRemote: data.gitRemote ?? null,
        gitBranch: data.gitBranch ?? null,
        baseRef: data.baseRef ?? null,
        displayOrder: nextDisplayOrder,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
```

- [ ] **Step 4: Add `mapProject` field**

Find:

```ts
  private static mapProject(row: typeof projects.$inferSelect): Project {
    return {
      id: row.id,
      name: row.name,
      path: row.path,
      gitRemote: row.gitRemote,
      gitBranch: row.gitBranch,
      baseRef: row.baseRef,
      createdAt: row.createdAt ?? '',
      updatedAt: row.updatedAt ?? '',
    };
  }
```

Replace with:

```ts
  private static mapProject(row: typeof projects.$inferSelect): Project {
    return {
      id: row.id,
      name: row.name,
      path: row.path,
      gitRemote: row.gitRemote,
      gitBranch: row.gitBranch,
      baseRef: row.baseRef,
      displayOrder: row.displayOrder,
      createdAt: row.createdAt ?? '',
      updatedAt: row.updatedAt ?? '',
    };
  }
```

- [ ] **Step 5: Add `displayOrder` to the `Project` interface**

Edit `src/shared/types.ts`. Find:

```ts
export interface Project {
  id: string;
  name: string;
  path: string;
  gitRemote: string | null;
  gitBranch: string | null;
  baseRef: string | null;
  createdAt: string;
  updatedAt: string;
}
```

Replace with:

```ts
export interface Project {
  id: string;
  name: string;
  path: string;
  gitRemote: string | null;
  gitBranch: string | null;
  baseRef: string | null;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 6: Add `reorderProjects` method**

In `DatabaseService.ts`, just before the `// ── Tasks ──` section header (right after `deleteProject`), add:

```ts
  static reorderProjects(orderedIds: string[]): void {
    const db = getDb();
    const rawDb = getRawDb();
    if (!rawDb) throw new Error('Raw database not available');

    const stmt = rawDb.prepare(`UPDATE projects SET display_order = ? WHERE id = ?`);
    const tx = rawDb.transaction((ids: string[]) => {
      ids.forEach((id, i) => stmt.run(i, id));
    });
    tx(orderedIds);
    void db; // drizzle handle is unused here; raw transaction is faster for batch updates
  }
```

Add the import for `getRawDb` at the top — find:

```ts
import { initDb, getDb } from '../db/client';
```

Replace with:

```ts
import { initDb, getDb, getRawDb } from '../db/client';
```

- [ ] **Step 7: Run `pnpm type-check`**

Run: `pnpm type-check`
Expected: PASS.

- [ ] **Step 8: Do not commit yet** — Task 6 wires the IPC.

---

### Task 6: Add `db:reorderProjects` IPC handler, preload bridge, and type

**Files:**

- Modify: `src/main/ipc/dbIpc.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/types/electron-api.d.ts`

- [ ] **Step 1: Add the IPC handler**

In `src/main/ipc/dbIpc.ts`, after the `db:deleteProject` handler (around line 32), insert:

```ts
ipcMain.handle('db:reorderProjects', (_event, orderedIds: string[]) => {
  try {
    DatabaseService.reorderProjects(orderedIds);
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});
```

- [ ] **Step 2: Expose it in the preload bridge**

In `src/main/preload.ts`, find:

```ts
  deleteProject: (id: string) => ipcRenderer.invoke('db:deleteProject', id),
```

Add immediately after it:

```ts
  reorderProjects: (orderedIds: string[]) => ipcRenderer.invoke('db:reorderProjects', orderedIds),
```

- [ ] **Step 3: Add the type to `ElectronAPI`**

In `src/types/electron-api.d.ts`, find the Projects block (around lines 36-40):

```ts
// Database - Projects
getProjects: () => Promise<IpcResponse<Project[]>>;
saveProject: (project: Partial<Project> & { name: string; path: string }) =>
  Promise<IpcResponse<Project>>;
deleteProject: (id: string) => Promise<IpcResponse<void>>;
```

Replace with:

```ts
// Database - Projects
getProjects: () => Promise<IpcResponse<Project[]>>;
saveProject: (project: Partial<Project> & { name: string; path: string }) =>
  Promise<IpcResponse<Project>>;
deleteProject: (id: string) => Promise<IpcResponse<void>>;
reorderProjects: (orderedIds: string[]) => Promise<IpcResponse<void>>;
```

- [ ] **Step 4: Run `pnpm type-check`**

Run: `pnpm type-check`
Expected: PASS.

- [ ] **Step 5: Do not commit yet** — Task 7 adds the renderer UI.

---

### Task 7: HTML5 drag-and-drop in `LeftSidebar`

**Files:**

- Modify: `src/renderer/components/LeftSidebar.tsx`

- [ ] **Step 1: Add the new prop to the interface**

Find:

```ts
interface LeftSidebarProps {
  projects: Project[];
  …
  remoteControlStates?: Record<string, RemoteControlState>;
}
```

Add `onReorderProjects` to the interface (anywhere — convention is alphabetical or near related props, but `onDeleteProject` is a fine neighbor):

```ts
  onReorderProjects: (orderedIds: string[]) => void;
```

Add it to the destructured props in the component signature too (right next to `onDeleteProject`):

```ts
  onReorderProjects,
```

- [ ] **Step 2: Add drag state**

Inside the component, near the other `useState` calls (after `collapsedArchived`):

```tsx
const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null);
const [dropTarget, setDropTarget] = useState<{ id: string; side: 'before' | 'after' } | null>(null);

const DRAG_MIME = 'application/x-dash-project-id';

function handleProjectDragStart(e: React.DragEvent, projectId: string) {
  e.dataTransfer.setData(DRAG_MIME, projectId);
  e.dataTransfer.effectAllowed = 'move';
  setDraggingProjectId(projectId);
}

function handleProjectDragEnd() {
  setDraggingProjectId(null);
  setDropTarget(null);
}

function handleProjectDragOver(e: React.DragEvent, projectId: string) {
  if (!draggingProjectId || draggingProjectId === projectId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const side: 'before' | 'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  setDropTarget((prev) =>
    prev?.id === projectId && prev.side === side ? prev : { id: projectId, side },
  );
}

function handleProjectDragLeave(e: React.DragEvent, projectId: string) {
  // Only clear if leaving to outside this row.
  const related = e.relatedTarget as Node | null;
  if (related && (e.currentTarget as HTMLElement).contains(related)) return;
  setDropTarget((prev) => (prev?.id === projectId ? null : prev));
}

function handleProjectDrop(e: React.DragEvent, targetId: string) {
  e.preventDefault();
  const draggedId = e.dataTransfer.getData(DRAG_MIME);
  setDropTarget(null);
  setDraggingProjectId(null);
  if (!draggedId || draggedId === targetId) return;

  const ids = projects.map((p) => p.id);
  const fromIdx = ids.indexOf(draggedId);
  const toIdx = ids.indexOf(targetId);
  if (fromIdx === -1 || toIdx === -1) return;

  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const dropAfter = e.clientY >= rect.top + rect.height / 2;

  const next = ids.slice();
  next.splice(fromIdx, 1);
  let insertIdx = next.indexOf(targetId);
  if (dropAfter) insertIdx += 1;
  next.splice(insertIdx, 0, draggedId);

  onReorderProjects(next);
}
```

- [ ] **Step 3: Wire the handlers and drop indicator on the project row**

Find the project row container in the **expanded** branch (around line 220 — the `<div className={\`group flex items-center gap-1.5 px-2 h-8 rounded-md…\`}` element). Wrap it in a relative wrapper that hosts the drop indicator and add the drag attributes to the inner row.

Replace:

```tsx
            return (
              <div key={project.id}>
                {/* Project row */}
                <div
                  className={`group flex items-center gap-1.5 px-2 h-8 rounded-md text-sm cursor-pointer transition-all duration-150 ${
                    isActive
                      ? 'text-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={() => {
                    onSelectProject(project.id);
                    if (collapsedProjects.has(project.id)) {
                      toggleCollapse(project.id);
                    }
                  }}
                >
```

With:

```tsx
            return (
              <div key={project.id} className="relative">
                {dropTarget?.id === project.id && dropTarget.side === 'before' && (
                  <div className="absolute left-2 right-2 -top-px h-[2px] bg-primary z-10 pointer-events-none" />
                )}
                {/* Project row */}
                <div
                  draggable
                  onDragStart={(e) => handleProjectDragStart(e, project.id)}
                  onDragEnd={handleProjectDragEnd}
                  onDragOver={(e) => handleProjectDragOver(e, project.id)}
                  onDragLeave={(e) => handleProjectDragLeave(e, project.id)}
                  onDrop={(e) => handleProjectDrop(e, project.id)}
                  className={`group flex items-center gap-1.5 px-2 h-8 rounded-md text-sm cursor-pointer transition-all duration-150 ${
                    isActive
                      ? 'text-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground'
                  } ${draggingProjectId === project.id ? 'opacity-50' : ''}`}
                  onClick={() => {
                    onSelectProject(project.id);
                    if (collapsedProjects.has(project.id)) {
                      toggleCollapse(project.id);
                    }
                  }}
                >
```

Then find the closing `</div>` of the outer `<div key={project.id}>` (the one that wraps both the project row and its nested tasks). Just before that closing tag, add the "after" drop indicator:

```tsx
                {dropTarget?.id === project.id && dropTarget.side === 'after' && (
                  <div className="absolute left-2 right-2 -bottom-px h-[2px] bg-primary z-10 pointer-events-none" />
                )}
              </div>
            );
```

- [ ] **Step 4: Run `pnpm type-check`**

Run: `pnpm type-check`
Expected: PASS for the file. App.tsx will still error on the missing `onReorderProjects` prop — fixed in Task 8.

- [ ] **Step 5: Do not commit yet.**

---

### Task 8: Wire `reorderProjects` in `App.tsx` and verify

**Files:**

- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Add the handler**

Add this function next to `handleDeleteProject` (around line 633 in App.tsx — the existing project CRUD callback):

```ts
async function handleReorderProjects(orderedIds: string[]) {
  // Optimistic local update.
  const idIndex = new Map(orderedIds.map((id, i) => [id, i]));
  setProjects((prev) =>
    prev
      .slice()
      .sort((a, b) => (idIndex.get(a.id) ?? 0) - (idIndex.get(b.id) ?? 0))
      .map((p, i) => ({ ...p, displayOrder: i })),
  );

  const result = await window.electronAPI.reorderProjects(orderedIds);
  if (!result.success) {
    // Revert by refetching from DB.
    const refreshed = await window.electronAPI.getProjects();
    if (refreshed.success && refreshed.data) setProjects(refreshed.data);
    toast.error('Failed to reorder projects: ' + (result.error ?? 'unknown error'));
  }
}
```

(`toast` is imported from `sonner` at the top of the file; `setProjects` is the existing state setter.)

- [ ] **Step 2: Pass the prop to `LeftSidebar`**

Find the `<LeftSidebar` JSX (around line 1032, where `onDeleteProject={handleDeleteProject}` is set). Add immediately next to it:

```tsx
onReorderProjects = { handleReorderProjects };
```

- [ ] **Step 3: Run `pnpm type-check`**

Run: `pnpm type-check`
Expected: PASS with no errors.

- [ ] **Step 4: Manual verification**

Run: `pnpm dev`

Verify:

1. With at least 3 projects in the sidebar, drag the third project above the first. A 2px primary-color line appears as the drop indicator. Release. Order updates immediately.
2. Reload the app (Cmd/Ctrl+R). New order persists.
3. Click a project's "settings" or "delete" button — the click still works (didn't get swallowed by drag handlers).
4. Add a new project via the folder dialog. It should appear at the **bottom** of the list (highest `display_order`).
5. Try to drag a project onto itself. No-op (no order change, no error).
6. Collapse the sidebar (icon mode). Confirm the project icons are NOT draggable (drag attempts do nothing).
7. Switch projects with archived tasks expanded. The archived list stays put — its rows are not affected by project drag.

If anything fails, stop and fix.

- [ ] **Step 5: Commit**

```bash
git add src/main/db/schema.ts src/main/db/migrate.ts src/main/services/DatabaseService.ts src/main/ipc/dbIpc.ts src/main/preload.ts src/types/electron-api.d.ts src/shared/types.ts src/renderer/components/LeftSidebar.tsx src/renderer/App.tsx
git commit -m "Add drag-and-drop project reordering

Projects in the expanded left sidebar can now be reordered by HTML5
drag. Order persists in SQLite via a new display_order column on the
projects table; new projects get the next available index."
```

---

## Final verification

- [ ] **Step 1: Run `pnpm type-check` one more time**

Run: `pnpm type-check`
Expected: PASS.

- [ ] **Step 2: Run `pnpm build`**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 3: Full manual smoke**

Run: `pnpm dev`. Walk through both feature checklists from Task 3 Step 6 and Task 8 Step 4 once more end-to-end. Confirm no console errors.

- [ ] **Step 4: Push the branch**

```bash
git push
```
