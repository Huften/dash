# Reliable Claude Session Resume — Design

**Date:** 2026-06-12
**Status:** Approved (pending spec review)

## Goal

Reopening a Dash task always continues the exact same Claude Code session it was
last running, deterministically — not "probably the most recent session in this
directory." This is session continuity, not a transcript browser.

## Problem

Resume today is non-deterministic and frequently fails:

1. **No session identity is tracked.** `startDirectPty` passes `claude -c -r`
   (`src/main/services/ptyManager.ts:379`) — "continue the most recent session in
   this cwd." Nothing ties a specific Claude session to a specific Dash task.
2. **Detection is POSIX-only.** `hasClaudeSession()`
   (`src/main/ipc/ptyIpc.ts:155`) splits and replaces on `/`. On Windows, paths
   use `\`, so the path-based and partial-match branches never match; resume often
   does not trigger at all.
3. **Worktree paths move and get reused.** The worktree pool claims reserves via
   `git worktree move`, and worktrees live at `…/worktrees/{task-slug}/`. A
   "most recent session in this cwd" strategy can resume the wrong session after a
   move, or miss it entirely.

The fix: capture the real `session_id` Claude assigns (already present in every
hook payload — see `src/main/services/ptyManager.ts:241`), persist it per task,
and resume by explicit ID.

## Decisions

- **Approach A** (chosen): capture & resume by explicit session ID.
- **No fallback heuristic** (chosen, simple path): when no session ID is stored,
  start a fresh Claude session. The `SessionStart` capture records the ID, so the
  next reopen resumes deterministically. The one-time gap self-heals after one run.
- **Main process owns the lookup.** Because `ptyId === task.id`
  (`src/renderer/components/MainContent.tsx:204` → `TerminalPane` →
  `SessionRegistry`), `startDirectPty` can read the stored session ID from the DB
  directly. The renderer does not need to plumb a `resume` flag.

## Data Model

Add one nullable column to the `tasks` table:

```
claude_session_id TEXT   -- last captured Claude Code session id, null until first SessionStart
```

- One terminal per task today → one ID per task is sufficient.
- No change to the `conversations` table (currently unused scaffolding).
- Migration generated via `pnpm drizzle:generate`; runs on startup like existing
  migrations.

`DatabaseService` gains:

- `setTaskSessionId(taskId: string, sessionId: string | null): void` (null clears it)
- `getTaskSessionId(taskId: string): string | null`

`Task` shared type (`src/shared/types.ts`) and DB row mapping include the new field.

## Capture Flow

Claude emits `session_id` on the `SessionStart` hook. Today `writeHookSettings`
(`src/main/services/ptyManager.ts:247`) only registers a `SessionStart` hook when
`task-context.json` exists, and that hook merely `cat`s the file.

Changes:

1. **Always register a `SessionStart` hook** that POSTs the hook payload to the
   hook server, capturing the session ID on every session start (startup and any
   resume). This makes the stored ID self-healing — if Claude forks a new session,
   the latest one is recorded.
2. The hook uses the existing curl-POST pattern already used by the Notification
   hooks (`curl -s -X POST -H "Content-Type: application/json" -d @- …`).
3. The existing `task-context.json` `cat` behavior is **preserved** as a second
   command in the same `SessionStart` hook array — the two commands are
   independent (one POSTs identity, one injects context).

New `HookServer` endpoint:

- `POST /hook/session?ptyId=<id>` — parse `session_id` from the JSON body, call
  `DatabaseService.setTaskSessionId(ptyId, sessionId)`. Best-effort; failures are
  logged, never block Claude. `ptyId` is the task id.

## Resume Flow

In `startDirectPty` (`src/main/services/ptyManager.ts:340`):

1. Look up the stored session ID for the task: `getTaskSessionId(options.id)`.
2. If an ID exists → spawn `claude --resume <session-id>` (replacing the current
   `-c -r` pair).
3. If no ID → spawn fresh `claude` (no resume flags).
4. `--dangerously-skip-permissions` is appended after resume args, as today.

The renderer's `resume` boolean and the `ptyHasClaudeSession` call in
`TerminalSessionManager` (`src/renderer/terminal/TerminalSessionManager.ts:312-329`)
are removed; the snapshot-based visual restore is unchanged. The CMD+R
reattach-restart path (`:336`) simply re-calls `startPty`, and main re-looks-up the
ID automatically.

## Cleanup of Obsolete Code

- Remove the `resume` parameter threading through `ptyStartDirect` IPC,
  `startPty`, and `PtyOptions`.
- Remove `hasClaudeSession()` and the `pty:hasClaudeSession` IPC handler +
  preload binding, since resume no longer depends on directory heuristics.

## Error Handling: Stale Session ID

If `claude --resume <id>` fails (session pruned or deleted), Claude exits
immediately. Handling:

1. Detect an early exit (e.g. within a short window) of a process spawned with a
   resume flag.
2. Clear the stored session ID for the task (`setTaskSessionId(taskId, null)` or a
   dedicated clear).
3. Trigger a fresh respawn (renderer restart path), which — finding no stored ID —
   starts a clean session. The next `SessionStart` captures a new ID.

## Components & Boundaries

| Unit                                     | Responsibility                         | Depends on                     |
| ---------------------------------------- | -------------------------------------- | ------------------------------ |
| `tasks.claude_session_id` + migration    | Persist per-task session identity      | Drizzle, SQLite                |
| `DatabaseService.{set,get}TaskSessionId` | Read/write the stored ID               | DB                             |
| `writeHookSettings` (SessionStart hook)  | Make Claude POST its session ID        | HookServer port                |
| `HookServer` `/hook/session`             | Receive payload, store ID              | DatabaseService                |
| `startDirectPty` resume logic            | Spawn with `--resume <id>` when stored | DatabaseService                |
| Early-exit handler                       | Clear stale ID, respawn fresh          | DatabaseService, PTY lifecycle |

## Testing

**Unit**

- `DatabaseService.setTaskSessionId` / `getTaskSessionId` round-trip, including
  null/clear.
- `writeHookSettings` emits a `SessionStart` hook that POSTs to `/hook/session`,
  and still includes the `task-context.json` `cat` command when that file exists.
- `HookServer` `/hook/session` parses `session_id` from the body and writes it via
  `DatabaseService`; malformed body is ignored without throwing.
- `startDirectPty` builds `--resume <id>` args when an ID is stored, and no resume
  flags when none is stored.

**Manual**

- Start a task, let Claude initialize, quit Dash, reopen → same session continues.
- Delete the underlying Claude session file, reopen the task → graceful fresh
  respawn, stored ID cleared, new ID captured.
- Windows: confirm capture + resume work end-to-end (no dependency on the removed
  POSIX-only heuristic).

## Out of Scope

- Transcript browsing / searchable history (different feature; the raw data lives
  in Claude's `~/.claude/projects/<dir>/*.jsonl`).
- Multiple concurrent Claude sessions per task (conversations table remains
  unused).
- Migrating existing tasks to a known session ID — they self-heal on first reopen.
