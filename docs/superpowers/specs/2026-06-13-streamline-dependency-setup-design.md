# Streamline Dependency Setup — Design

**Date:** 2026-06-13
**Status:** Approved (pending spec review)

## Problem

Getting a working dev environment is a two-step, easy-to-get-wrong process:

```bash
pnpm install
npx electron-rebuild -f -w node-pty,better-sqlite3   # easy to forget
```

Forgetting the second step produces cryptic `NODE_MODULE_VERSION` mismatch crashes at
runtime. The native modules (`better-sqlite3`, `node-pty`) require a compiler toolchain,
which is especially painful on **Windows** — the platform the maintainer currently develops
on, but which the project doesn't officially document. There is also version drift: local
`pnpm` is 10.x while CI pins `pnpm` 9, and nothing enforces the Node 22 requirement.

## Goal

`pnpm install` is the **only** command needed to get a working dev environment on macOS,
Linux, and Windows. A `pnpm doctor` command diagnoses prerequisite gaps and, on Windows, can
fix the build toolchain automatically.

## Pains addressed

1. **Forgetting the rebuild step** → automated via `postinstall`.
2. **Windows build toolchain** → detected and auto-installable via `pnpm doctor`.
3. **Onboarding new contributors** → one command + accurate docs.
4. **Version drift / wrong Node** → `engines` + `engine-strict` + `packageManager`/Corepack.

## Components

### 1. Automatic native rebuild — `scripts/postinstall.mjs`

- Wired as `"postinstall"` in `package.json`.
- Runs `electron-rebuild -f -w node-pty,better-sqlite3`.
- On failure, exits non-zero and prints:
  `Native rebuild failed — run \`pnpm doctor\` to check your build toolchain.`
- Escape hatch: if `DASH_SKIP_REBUILD` is set (any truthy value), skip the rebuild and log
  that it was skipped. Useful for CI edge cases or environments without Electron.
- **Does not** perform any system-level installation. Its only job is the rebuild; toolchain
  remediation lives in `doctor`. This keeps a plain `pnpm install` from ever triggering a
  UAC prompt or modifying the system.

### 2. Prerequisite diagnostics — `scripts/doctor.mjs`

Wired as `"doctor"` script (`node scripts/doctor.mjs`). Cross-platform. Prints a checklist
with `pass` / `warn` / `fail` status and an actionable fix for each item.

Checks (all platforms):

- **Node** ≥ 22 (`process.versions.node`) — `fail` if below.
- **pnpm** present and matches the pinned major (`packageManager`) — `warn` on mismatch.
- **git** present — `fail` if missing.
- **Claude Code CLI** (`claude --version`) — `warn` only (not required to build, but the app
  needs it at runtime).

Windows-only checks:

- **Python** (`py --version` or `python --version`).
- **MSVC C++ build tools** — detected via `vswhere`
  (`%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe`) requiring the
  `Microsoft.VisualStudio.Component.VC.Tools.x86.x64` component, with a `where cl` fallback.

When a Windows build-tool dependency is missing, `doctor` **auto-installs** it:

- Prefer `winget`:
  - `winget install -e --id Python.Python.3.12`
  - `winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override
"--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`
- Fall back to `choco` (`choco install python visualstudio2022buildtools
visualstudio2022-workload-vctools -y`) if `winget` is unavailable.
- If neither package manager is present, print manual install links and exit non-zero.
- If the install requires elevation and the process lacks admin rights, detect the failure
  and surface a clear "re-run an elevated terminal" message rather than failing silently.

Auto-install runs **only** from an explicit `pnpm doctor` invocation, never from
`postinstall`.

Exit code: `0` when all hard checks pass (warnings allowed), non-zero when any `fail`
remains after remediation.

### 3. Version pinning

In `package.json`:

- `"engines": { "node": ">=22" }`
- `"packageManager": "pnpm@10.<minor>.<patch>"` — pin to the current local pnpm (10.x) so
  Corepack provisions a consistent version.

In `.npmrc`:

- `engine-strict=true` — installing under the wrong Node fails fast with a legible error.

### 4. CI alignment — `.github/workflows/build.yml`

- Remove the explicit `Rebuild native modules for Electron` steps from `build-mac` and
  `build-linux` (now handled by `postinstall` during `pnpm install`).
- Align `pnpm/action-setup` from `version: 9` to match the pinned `packageManager` major
  (10), resolving the local/CI drift. (Where `packageManager` is set, `action-setup` can
  omit an explicit version and honor it; pick whichever is least surprising during
  implementation.)
- The `version-check` job never runs `pnpm install`, so `postinstall` does not affect it.

### 5. Documentation

- **README.md**: collapse `Setup` to `pnpm install`. Add a **Windows** prerequisites
  subsection and document `pnpm doctor`. List Windows as a supported _development_ platform
  (packaging targets remain macOS arm64 / Linux x64).
- **CLAUDE.md**: update the Commands block — replace the manual `electron-rebuild` line with
  `pnpm install` (auto-rebuild) and add `pnpm doctor`. Update the Requirements note to
  mention Windows dev support.

## Files touched

| File                          | Change                                               |
| ----------------------------- | ---------------------------------------------------- |
| `scripts/postinstall.mjs`     | new — auto rebuild wrapper                           |
| `scripts/doctor.mjs`          | new — prerequisite diagnostics + Win fixes           |
| `package.json`                | `postinstall`, `doctor`, `engines`, `packageManager` |
| `.npmrc`                      | `engine-strict=true`                                 |
| `.github/workflows/build.yml` | drop explicit rebuild steps; align pnpm version      |
| `README.md`                   | setup + Windows section + `pnpm doctor`              |
| `CLAUDE.md`                   | commands + requirements                              |

## Non-goals

- Eliminating native compilation via prebuilt binaries (considered, rejected as fragile for
  `node-pty` across Electron ABIs).
- Adding Windows as a _packaging/release_ target — dev support only.
- Changing the Electron, better-sqlite3, or node-pty versions.

## Risks / edge cases

- **Slower installs:** every `pnpm install` now pays the rebuild cost (a few seconds).
  Accepted for correctness; `DASH_SKIP_REBUILD` is the escape hatch.
- **winget/UAC:** auto-install may prompt for elevation. `doctor` must detect lack of admin
  and instruct rather than hang or fail opaquely.
- **Corepack:** pinning `packageManager` assumes Corepack is enabled. README should mention
  `corepack enable` if needed.
