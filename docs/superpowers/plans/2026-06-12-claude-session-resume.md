# Reliable Claude Session Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make reopening a Dash task always continue the exact same Claude Code session, by capturing Claude's `session_id` per task and resuming with `claude --resume <id>`.

**Architecture:** Claude emits its `session_id` on the `SessionStart` hook. We register a SessionStart hook that POSTs the payload to Dash's existing local hook server, which stores the id on the `tasks` row. On spawn, the main process looks up the stored id (since `ptyId === task.id`) and passes `--resume <id>`; with no stored id it starts fresh. A stale id (deleted session) causes an immediate Claude exit, which we detect and recover from by clearing the id and respawning fresh.

**Tech Stack:** Electron 30 (main process), better-sqlite3 + Drizzle ORM, node-pty, TypeScript 5.

**Testing note:** This repo has **no test runner** (no jest/vitest; only `pnpm type-check`, ESLint via Husky, and `pnpm build`). Adding a test framework is out of scope. Each task is therefore verified with `pnpm type-check` as the automated gate, and the runtime behaviour is verified with the explicit manual steps in Task 7. This is a deliberate deviation from test-first TDD because the project has no harness to run a unit test against the Electron main process and its native modules.

---

## File Structure

| File                                              | Change | Responsibility                                                                             |
| ------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| `src/main/db/schema.ts`                           | Modify | Add `claudeSessionId` column to `tasks` (Drizzle typing)                                   |
| `src/main/db/migrate.ts`                          | Modify | `ALTER TABLE tasks ADD COLUMN claude_session_id` for existing DBs                          |
| `src/shared/types.ts`                             | Modify | Add `claudeSessionId` to `Task`; remove `resume` from `PtyOptions`                         |
| `src/main/services/DatabaseService.ts`            | Modify | `getTaskSessionId` / `setTaskSessionId`; map new column in `mapTask`                       |
| `src/main/services/HookServer.ts`                 | Modify | `POST /hook/session` endpoint storing the id                                               |
| `src/main/services/ptyManager.ts`                 | Modify | Always register SessionStart capture hook; resume by stored id; stale-resume recovery      |
| `src/main/ipc/ptyIpc.ts`                          | Modify | Drop `resume` from `pty:startDirect`; remove `pty:hasClaudeSession` + `hasClaudeSession()` |
| `src/main/preload.ts`                             | Modify | Remove `ptyHasClaudeSession` binding                                                       |
| `src/types/electron-api.d.ts`                     | Modify | Remove `resume` from `ptyStartDirect`; remove `ptyHasClaudeSession`                        |
| `src/renderer/terminal/TerminalSessionManager.ts` | Modify | Remove `resume` boolean + `ptyHasClaudeSession` call; keep snapshot restore                |

---

## Task 1: Add `claude_session_id` column to the schema and migration

**Files:**

- Modify: `src/main/db/schema.ts:33` (inside `tasks` table definition)
- Modify: `src/main/db/migrate.ts:128-132` (add ALTER block after the last existing one)

- [ ] **Step 1: Add the column to the Drizzle schema**

In `src/main/db/schema.ts`, inside the `tasks` table definition, add the column right after the `autoApprove` line (line 33):

```ts
    autoApprove: integer('auto_approve', { mode: 'boolean' }).default(false),
    claudeSessionId: text('claude_session_id'),
```

- [ ] **Step 2: Add the runtime migration for existing databases**

In `src/main/db/migrate.ts`, add a new ALTER block immediately after the `linked_branch_created_by_dash` block (after line 132, before `rawDb.pragma('foreign_keys = ON');`):

```ts
try {
  rawDb.exec(`ALTER TABLE tasks ADD COLUMN claude_session_id TEXT`);
} catch {
  /* already exists */
}
```

- [ ] **Step 3: Verify it type-checks**

Run: `pnpm type-check`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/main/db/schema.ts src/main/db/migrate.ts
git commit -m "feat(db): add claude_session_id column to tasks"
```

---

## Task 2: Add DatabaseService accessors and map the new column

**Files:**

- Modify: `src/shared/types.ts:46` (add to `Task` interface)
- Modify: `src/main/services/DatabaseService.ts` (add methods + map in `mapTask`)

- [ ] **Step 1: Add the field to the `Task` shared type**

In `src/shared/types.ts`, inside the `Task` interface, add after the `autoApprove` line (line 46):

```ts
autoApprove: boolean;
claudeSessionId: string | null;
```

- [ ] **Step 2: Map the column in `mapTask`**

In `src/main/services/DatabaseService.ts`, inside `mapTask` (around line 235), add after `autoApprove`:

```ts
      autoApprove: row.autoApprove ?? false,
      claudeSessionId: row.claudeSessionId ?? null,
```

- [ ] **Step 3: Add the accessor methods**

In `src/main/services/DatabaseService.ts`, add these two static methods immediately after `restoreTask` (after line 162, before the `// ── Conversations` comment):

```ts
  static getTaskSessionId(taskId: string): string | null {
    const db = getDb();
    const row = db
      .select({ claudeSessionId: tasks.claudeSessionId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get();
    return row?.claudeSessionId ?? null;
  }

  static setTaskSessionId(taskId: string, sessionId: string | null): void {
    const db = getDb();
    db.update(tasks)
      .set({ claudeSessionId: sessionId, updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, taskId))
      .run();
  }
```

- [ ] **Step 4: Verify it type-checks**

Run: `pnpm type-check`
Expected: PASS. (If `mapTask`'s return type complains about a missing property, confirm Step 1 added `claudeSessionId` to `Task`.)

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/main/services/DatabaseService.ts
git commit -m "feat(db): add get/set task session id accessors"
```

---

## Task 3: Add the `/hook/session` endpoint to HookServer

**Files:**

- Modify: `src/main/services/HookServer.ts` (imports + new POST route)

- [ ] **Step 1: Import DatabaseService**

In `src/main/services/HookServer.ts`, add to the imports at the top (after the existing `import { tasks } from '../db/schema';` on line 6):

```ts
import { DatabaseService } from './DatabaseService';
```

- [ ] **Step 2: Add the POST `/hook/session` route**

In `src/main/services/HookServer.ts`, inside the `http.createServer` request handler, add this block immediately after the existing `/hook/notification` POST block (after its closing `return;` at line 132, before the final `res.writeHead(404)`):

```ts
// Session-capture hook — receives the SessionStart payload as JSON on
// stdin. We persist session_id so the task can be resumed deterministically
// with `claude --resume <id>`. ptyId is the task id.
if (req.method === 'POST' && ptyId && url.pathname === '/hook/session') {
  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
  });
  req.on('end', () => {
    try {
      const payload = JSON.parse(body);
      const sessionId: unknown = payload.session_id;
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        DatabaseService.setTaskSessionId(ptyId, sessionId);
        console.error(`[HookServer] Captured session id for ptyId=${ptyId}: ${sessionId}`);
      }
    } catch (err) {
      console.error('[HookServer] Failed to parse session body:', err);
    }
    res.writeHead(200);
    res.end('ok');
  });
  return;
}
```

- [ ] **Step 3: Verify it type-checks**

Run: `pnpm type-check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/services/HookServer.ts
git commit -m "feat(hooks): add /hook/session endpoint to capture session id"
```

---

## Task 4: Always register a SessionStart capture hook in `writeHookSettings`

**Files:**

- Modify: `src/main/services/ptyManager.ts:282-296` (the SessionStart section of `writeHookSettings`)

- [ ] **Step 1: Replace the conditional SessionStart block with an always-on capture hook**

In `src/main/services/ptyManager.ts`, the current block is:

```ts
// Auto-detect task-context.json and inject SessionStart hook if it exists
const contextPath = path.join(claudeDir, 'task-context.json');
if (fs.existsSync(contextPath)) {
  hookSettings.SessionStart = [
    {
      matcher: 'startup',
      hooks: [
        {
          type: 'command',
          command: `cat "${contextPath}"`,
        },
      ],
    },
  ];
}
```

Replace it with:

```ts
// Always capture the Claude session id on SessionStart so the task can be
// resumed deterministically later. Omitting the matcher runs this for every
// SessionStart source (startup, resume, clear, compact), so the stored id
// self-heals if Claude forks a new session.
const sessionCaptureCommand = `curl -s --connect-timeout 2 -X POST -H "Content-Type: application/json" -d @- http://127.0.0.1:${port}/hook/session?ptyId=${ptyId}`;
const sessionStartEntries: unknown[] = [
  { hooks: [{ type: 'command', command: sessionCaptureCommand }] },
];

// Inject task-context.json on startup only, if present.
const contextPath = path.join(claudeDir, 'task-context.json');
if (fs.existsSync(contextPath)) {
  sessionStartEntries.push({
    matcher: 'startup',
    hooks: [{ type: 'command', command: `cat "${contextPath}"` }],
  });
}
hookSettings.SessionStart = sessionStartEntries;
```

- [ ] **Step 2: Verify it type-checks**

Run: `pnpm type-check`
Expected: PASS.

- [ ] **Step 3: Manually inspect the generated settings**

This writes to a task's `.claude/settings.local.json`. We verify the shape now by reasoning about the code; full runtime verification happens in Task 7. Confirm by reading the edited block that:

- `SessionStart` always contains the curl-POST capture entry (no `matcher`).
- When `task-context.json` exists, a second `{ matcher: 'startup', … cat … }` entry is appended.

- [ ] **Step 4: Commit**

```bash
git add src/main/services/ptyManager.ts
git commit -m "feat(hooks): always register SessionStart session-capture hook"
```

---

## Task 5: Resume by stored session id + stale-session recovery in `startDirectPty`

**Files:**

- Modify: `src/main/services/ptyManager.ts:9` (import), `:13-18` (PtyRecord), `:340-445` (`startDirectPty`)

- [ ] **Step 1: Import DatabaseService**

In `src/main/services/ptyManager.ts`, add after the existing `import { hookServer } from './HookServer';` (line 8):

```ts
import { DatabaseService } from './DatabaseService';
```

- [ ] **Step 2: Extend `PtyRecord` with spawn metadata**

Replace the `PtyRecord` interface (lines 13-18) with:

```ts
interface PtyRecord {
  proc: any; // IPty from node-pty
  cwd: string;
  isDirectSpawn: boolean;
  owner: WebContents | null;
  spawnedAt?: number;
  resumedSessionId?: string | null;
}
```

- [ ] **Step 3: Add the stale-resume threshold constant**

In `src/main/services/ptyManager.ts`, add near the top after `const ptys = new Map…` (line 20):

```ts
// If a `--resume <id>` spawn exits within this window, treat the stored session
// as stale/missing, clear it, and respawn fresh.
const STALE_RESUME_MS = 3000;
```

- [ ] **Step 4: Build resume args from the stored session id**

In `startDirectPty`, replace the current args block (lines 377-380):

```ts
const args: string[] = [];
if (options.resume) {
  args.push('-c', '-r');
}
```

with:

```ts
const storedSessionId = DatabaseService.getTaskSessionId(options.id);
const args: string[] = [];
if (storedSessionId) {
  args.push('--resume', storedSessionId);
}
```

- [ ] **Step 5: Record spawn metadata**

In `startDirectPty`, replace the `record` initialization (lines 396-401):

```ts
const record: PtyRecord = {
  proc,
  cwd: options.cwd,
  isDirectSpawn: true,
  owner: options.sender || null,
};
```

with:

```ts
const record: PtyRecord = {
  proc,
  cwd: options.cwd,
  isDirectSpawn: true,
  owner: options.sender || null,
  spawnedAt: Date.now(),
  resumedSessionId: storedSessionId,
};
```

- [ ] **Step 6: Add stale-resume recovery to the exit handler**

In `startDirectPty`, replace the `proc.onExit` handler (lines 418-427):

```ts
proc.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
  // Skip if this PTY was replaced by a new spawn (kill+restart on reattach)
  if (ptys.get(options.id) !== record) return;
  activityMonitor.unregister(options.id);
  remoteControlService.unregister(options.id);
  if (record.owner && !record.owner.isDestroyed()) {
    record.owner.send(`pty:exit:${options.id}`, { exitCode, signal });
  }
  ptys.delete(options.id);
});
```

with:

```ts
proc.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
  // Skip if this PTY was replaced by a new spawn (kill+restart on reattach)
  if (ptys.get(options.id) !== record) return;
  activityMonitor.unregister(options.id);
  remoteControlService.unregister(options.id);

  // A resume spawn that exits almost immediately means the stored session is
  // stale (pruned/deleted). Clear it and respawn fresh instead of surfacing
  // the exit to the renderer (which would drop to a shell fallback).
  const exitedEarly = Date.now() - (record.spawnedAt ?? 0) < STALE_RESUME_MS;
  if (record.resumedSessionId && exitedEarly) {
    console.error(
      `[ptyManager] Resume of session ${record.resumedSessionId} failed (exit ${exitCode}); clearing and respawning fresh for ${options.id}`,
    );
    DatabaseService.setTaskSessionId(options.id, null);
    ptys.delete(options.id);
    void startDirectPty({
      id: options.id,
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      autoApprove: options.autoApprove,
      isDark: options.isDark,
      sender: record.owner ?? undefined,
    });
    return;
  }

  if (record.owner && !record.owner.isDestroyed()) {
    record.owner.send(`pty:exit:${options.id}`, { exitCode, signal });
  }
  ptys.delete(options.id);
});
```

- [ ] **Step 7: Remove the now-unused `resume` field from the options type**

In `startDirectPty`'s options object type (lines 340-348), remove the `resume?: boolean;` line:

```ts
export async function startDirectPty(options: {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  autoApprove?: boolean;
  isDark?: boolean;
  sender?: WebContents;
}): Promise<{
```

- [ ] **Step 8: Verify it type-checks**

Run: `pnpm type-check`
Expected: PASS. (Errors here likely mean a caller still passes `resume` — that is fixed in Task 6.)

- [ ] **Step 9: Commit**

```bash
git add src/main/services/ptyManager.ts
git commit -m "feat(pty): resume by stored session id with stale-session recovery"
```

---

## Task 6: Remove obsolete `resume` plumbing and `hasClaudeSession`

**Files:**

- Modify: `src/main/ipc/ptyIpc.ts:1-5` (imports), `:24-33` (args type), `:102-109` (handler), `:155-176` (`hasClaudeSession`)
- Modify: `src/main/preload.ts:95-96`
- Modify: `src/types/electron-api.d.ts:100-116` (and the `ptyHasClaudeSession` declaration)
- Modify: `src/shared/types.ts:118-125` (`PtyOptions`)
- Modify: `src/renderer/terminal/TerminalSessionManager.ts:310-329`, `:613-634`

- [ ] **Step 1: Drop `resume` from the `pty:startDirect` IPC args**

In `src/main/ipc/ptyIpc.ts`, in the `pty:startDirect` handler args type (lines 24-33), remove the `resume?: boolean;` line so it reads:

```ts
      args: {
        id: string;
        cwd: string;
        cols: number;
        rows: number;
        autoApprove?: boolean;
        isDark?: boolean;
      },
```

- [ ] **Step 2: Remove the `pty:hasClaudeSession` handler and `hasClaudeSession()` function**

In `src/main/ipc/ptyIpc.ts`, delete the handler block (lines 102-109):

```ts
// Check if a Claude session exists for a given working directory
ipcMain.handle('pty:hasClaudeSession', async (_event, cwd: string) => {
  try {
    return { success: true, data: hasClaudeSession(cwd) };
  } catch (error) {
    return { success: false, data: false, error: String(error) };
  }
});
```

and delete the entire `hasClaudeSession` function (lines 151-176, the JSDoc comment through the closing brace).

- [ ] **Step 3: Remove now-unused imports in ptyIpc**

In `src/main/ipc/ptyIpc.ts`, `hasClaudeSession` used `path`, `fs`, `os`, `crypto`. Check whether any remain used elsewhere in the file (e.g. `writeTaskContext` handler). Run a search:

Run: `grep -nE "\b(path|fs|os|crypto)\." src/main/ipc/ptyIpc.ts`
For any of `path`/`fs`/`os`/`crypto` with **zero** remaining matches, remove its import line from the top of the file (lines 2-5). Leave imports that still have matches.

- [ ] **Step 4: Remove the preload binding**

In `src/main/preload.ts`, delete lines 95-96:

```ts
  // Session detection
  ptyHasClaudeSession: (cwd: string) => ipcRenderer.invoke('pty:hasClaudeSession', cwd),
```

- [ ] **Step 5: Update the electron-api type declarations**

In `src/types/electron-api.d.ts`, remove `resume?: boolean;` from the `ptyStartDirect` args (line 107) so it reads:

```ts
  ptyStartDirect: (args: {
    id: string;
    cwd: string;
    cols: number;
    rows: number;
    autoApprove?: boolean;
    isDark?: boolean;
  }) => Promise<
```

Then remove the `ptyHasClaudeSession` declaration line (search for `ptyHasClaudeSession:` in the file and delete that line).

- [ ] **Step 6: Remove `resume` from `PtyOptions`**

In `src/shared/types.ts`, remove the `resume?: boolean;` line from `PtyOptions` (line 124) so it reads:

```ts
export interface PtyOptions {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  autoApprove?: boolean;
}
```

- [ ] **Step 7: Remove the renderer resume logic**

In `src/renderer/terminal/TerminalSessionManager.ts`, replace the Claude-mode resume detection block (lines 310-329):

```ts
      } else {
        // Claude Code mode: try direct spawn, fall back to shell
        let resume = false;
        let existingSnapshot: TerminalSnapshot | null = null;
        try {
          const snapshotResp = await window.electronAPI.ptyGetSnapshot(this.id);
          if (snapshotResp.success && snapshotResp.data) {
            existingSnapshot = snapshotResp.data;
          }
          // Always resume if a Claude session exists (e.g. after app restart)
          const sessionResp = await window.electronAPI.ptyHasClaudeSession(this.cwd);
          if (sessionResp.success && sessionResp.data) {
            resume = true;
          }
        } catch {
          // Best effort
        }
        if (gen !== this.attachGeneration) return;

        let result = await this.startPty(resume);
        if (gen !== this.attachGeneration) return;
```

with:

```ts
      } else {
        // Claude Code mode: try direct spawn, fall back to shell. Resume is
        // decided entirely in the main process from the stored session id.
        let existingSnapshot: TerminalSnapshot | null = null;
        try {
          const snapshotResp = await window.electronAPI.ptyGetSnapshot(this.id);
          if (snapshotResp.success && snapshotResp.data) {
            existingSnapshot = snapshotResp.data;
          }
        } catch {
          // Best effort
        }
        if (gen !== this.attachGeneration) return;

        let result = await this.startPty();
        if (gen !== this.attachGeneration) return;
```

- [ ] **Step 8: Update the second `startPty` call and the `!resume` guard**

In the same file, in the reattach-restart branch, change the second call (line 344) from `result = await this.startPty(resume);` to:

```ts
result = await this.startPty();
```

Then update the task-context info-line guard (line 365). It currently reads `if (result.taskContextMeta && !result.reattached && !resume) {`. Since `resume` no longer exists here, change it to:

```ts
        if (result.taskContextMeta && !result.reattached) {
```

- [ ] **Step 9: Remove the `resume` parameter from `startPty`**

In the same file, change the `startPty` signature (line 613) and its IPC call (lines 626-634). Replace:

```ts
  private async startPty(resume: boolean = false): Promise<{
```

with:

```ts
  private async startPty(): Promise<{
```

and remove the `resume,` line from the `ptyStartDirect` call object (line 632), so the call passes only `id`, `cwd`, `cols`, `rows`, `autoApprove`, `isDark`.

- [ ] **Step 10: Verify it type-checks**

Run: `pnpm type-check`
Expected: PASS with no references to `resume` or `ptyHasClaudeSession` remaining.

- [ ] **Step 11: Confirm no stragglers**

Run: `grep -rnE "ptyHasClaudeSession|hasClaudeSession|\bresume\b" src/`
Expected: no matches in `src/` except, at most, this is acceptable only if a match is an unrelated word. There should be **zero** matches for `ptyHasClaudeSession` and `hasClaudeSession`, and no `resume` flag plumbing remaining.

- [ ] **Step 12: Commit**

```bash
git add src/main/ipc/ptyIpc.ts src/main/preload.ts src/types/electron-api.d.ts src/shared/types.ts src/renderer/terminal/TerminalSessionManager.ts
git commit -m "refactor(pty): remove resume flag plumbing and hasClaudeSession heuristic"
```

---

## Task 7: End-to-end verification

**Files:** none (manual verification).

- [ ] **Step 1: Full type-check and build**

Run: `pnpm type-check && pnpm build`
Expected: both PASS with no errors.

- [ ] **Step 2: Rebuild native modules and launch**

Run: `npx electron-rebuild -f -w node-pty,better-sqlite3` then `pnpm dev`
Expected: app launches.

- [ ] **Step 3: Capture verification**

1. Create/open a task and let Claude initialize.
2. In the task's worktree, open `.claude/settings.local.json` and confirm a `SessionStart` hook with a `curl … /hook/session?ptyId=<taskId>` command exists.
3. In the running app's main-process console, confirm a line like `[HookServer] Captured session id for ptyId=<taskId>: <uuid>`.
4. Inspect the DB (`~/.config/Dash/app.db` on Linux, `~/Library/Application Support/Dash/app.db` on macOS, or the Windows equivalent under `%APPDATA%/Dash/app.db`): `SELECT id, claude_session_id FROM tasks;` — the task row has a non-null `claude_session_id`.

- [ ] **Step 4: Resume verification**

1. Send Claude a memorable message (e.g. "remember the number 4279").
2. Fully quit Dash and relaunch.
3. Reopen the same task. Confirm in the main-process console that `startDirectPty` spawned with `--resume <id>` (add a temporary log if needed, or observe Claude continuing the prior conversation).
4. Ask Claude "what number did I ask you to remember?" — it recalls 4279, proving the same session resumed.

- [ ] **Step 5: Stale-session recovery verification**

1. With the task closed, delete the Claude session file for it from `~/.claude/projects/<dir>/<session-id>.jsonl`.
2. Reopen the task.
3. Expected: Claude starts a **fresh** session (no error/shell fallback), the console logs `Resume of session … failed … respawning fresh`, and `SELECT claude_session_id …` shows a new id captured after the fresh start.

- [ ] **Step 6: Final commit (if any temporary logs were added, remove them first)**

```bash
git add -A
git commit -m "chore: verify claude session resume end-to-end"
```

(Skip this commit if no files changed during verification.)

---

## Self-Review Notes

- **Spec coverage:** Data model (Task 1-2), capture flow (Task 3-4), resume flow (Task 5), cleanup of obsolete code (Task 6), stale-id error handling (Task 5 Step 6), testing (Task 7). All spec sections map to tasks.
- **Migration approach:** The spec mentioned `pnpm drizzle:generate`, but the repo's actual pattern is hand-written `ALTER TABLE` blocks in `migrate.ts` (the CREATE TABLE statements are minimal and columns are added via ALTER). Task 1 follows the existing pattern; the schema.ts change keeps Drizzle's types in sync. This is an intentional adaptation to the codebase's real convention.
- **Testing approach:** No test runner exists; verification is `pnpm type-check` per task + manual runtime steps (Task 7), as flagged in the header.
- **Type consistency:** `setTaskSessionId(taskId, sessionId: string | null)` and `getTaskSessionId(taskId): string | null` are used identically in DatabaseService, HookServer, and ptyManager. `claudeSessionId` is the property name across schema, `Task`, and `mapTask`.
