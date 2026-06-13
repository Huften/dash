# Streamline Dependency Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pnpm install` the only command needed for a working Dash dev environment on macOS, Linux, and Windows, with a `pnpm doctor` command that diagnoses and (on Windows) auto-fixes the native build toolchain.

**Architecture:** A `postinstall` hook auto-runs `electron-rebuild` after every install (killing the forgotten-rebuild crash class). A standalone `scripts/doctor.mjs` reports prerequisite status and, on Windows, auto-installs Python + MSVC C++ build tools via winget/choco — but only when invoked explicitly, never from `postinstall`. Version drift is closed with `engines`, `engine-strict`, and a pinned `packageManager`.

**Tech Stack:** Node ESM scripts (`.mjs`), pnpm 10 + Corepack, `@electron/rebuild`, GitHub Actions.

**Note on testing:** This repo has no test runner. These are build-tooling scripts; verification is done by executing them and observing output, plus confirming `pnpm install` and the app still work. Do not add a test framework — it is out of scope.

---

### Task 1: Auto-rebuild via `postinstall`

**Files:**

- Create: `scripts/postinstall.mjs`
- Modify: `package.json` (scripts block)

- [ ] **Step 1: Create the postinstall wrapper**

Create `scripts/postinstall.mjs`:

```js
#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

if (process.env.DASH_SKIP_REBUILD) {
  console.log('[postinstall] DASH_SKIP_REBUILD set — skipping native rebuild.');
  process.exit(0);
}

console.log('[postinstall] Rebuilding native modules (node-pty, better-sqlite3) for Electron…');

const result = spawnSync('electron-rebuild', ['-f', '-w', 'node-pty,better-sqlite3'], {
  stdio: 'inherit',
  shell: true,
});

if (result.status !== 0) {
  console.error(
    '\n[postinstall] Native rebuild failed — run `pnpm doctor` to check your build toolchain.\n',
  );
  process.exit(result.status ?? 1);
}
```

- [ ] **Step 2: Wire `postinstall` in package.json**

In `package.json`, add the `postinstall` entry to the `scripts` block (place it after `"rebuild"`):

```json
    "rebuild": "electron-rebuild -f -w node-pty,better-sqlite3",
    "postinstall": "node scripts/postinstall.mjs",
```

- [ ] **Step 3: Verify the rebuild runs on install**

Run: `pnpm install`
Expected: output includes `[postinstall] Rebuilding native modules…` and install completes with exit code 0.

- [ ] **Step 4: Verify the skip flag works**

Run (bash): `DASH_SKIP_REBUILD=1 node scripts/postinstall.mjs`
Run (PowerShell): `$env:DASH_SKIP_REBUILD=1; node scripts/postinstall.mjs; Remove-Item Env:DASH_SKIP_REBUILD`
Expected: prints `DASH_SKIP_REBUILD set — skipping native rebuild.` and exits 0 without rebuilding.

- [ ] **Step 5: Verify the app still launches**

Run: `pnpm dev`
Expected: Electron window opens with no `NODE_MODULE_VERSION` / native-module error. Close it after confirming.

- [ ] **Step 6: Commit**

```bash
git add scripts/postinstall.mjs package.json
git commit -m "feat(setup): auto-rebuild native modules on install via postinstall"
```

---

### Task 2: `pnpm doctor` diagnostics + Windows auto-install

**Files:**

- Create: `scripts/doctor.mjs`
- Modify: `package.json` (scripts block)

- [ ] **Step 1: Create the doctor script**

Create `scripts/doctor.mjs`:

```js
#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const isWindows = process.platform === 'win32';
let hardFailure = false;
const results = [];

function record(status, name, detail) {
  results.push({ status, name, detail });
  if (status === 'fail') hardFailure = true;
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', shell: isWindows, ...opts });
}

function has(cmd, args = ['--version']) {
  const r = run(cmd, args);
  return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : null;
}

function autoInstallWindows(missing) {
  const hasWinget = has('winget', ['--version']);
  const hasChoco = has('choco', ['--version']);

  if (!hasWinget && !hasChoco) {
    record(
      'fail',
      'Auto-install',
      'No winget or choco found. Install manually:\n' +
        '      Python:      https://www.python.org/downloads/\n' +
        '      Build Tools: https://visualstudio.microsoft.com/visual-studio-build-tools/',
    );
    return;
  }

  const installs = [];
  if (hasWinget) {
    if (missing.includes('python')) {
      installs.push([
        'winget',
        [
          'install',
          '-e',
          '--id',
          'Python.Python.3.12',
          '--accept-package-agreements',
          '--accept-source-agreements',
        ],
      ]);
    }
    if (missing.includes('vctools')) {
      installs.push([
        'winget',
        [
          'install',
          '-e',
          '--id',
          'Microsoft.VisualStudio.2022.BuildTools',
          '--accept-package-agreements',
          '--accept-source-agreements',
          '--override',
          '--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended',
        ],
      ]);
    }
  } else {
    const pkgs = [];
    if (missing.includes('python')) pkgs.push('python');
    if (missing.includes('vctools')) {
      pkgs.push('visualstudio2022buildtools', 'visualstudio2022-workload-vctools');
    }
    installs.push(['choco', ['install', ...pkgs, '-y']]);
  }

  for (const [cmd, args] of installs) {
    console.log(`\n[doctor] Installing via ${cmd}: ${args.join(' ')}`);
    const r = run(cmd, args, { stdio: 'inherit', encoding: undefined });
    if (r.status !== 0) {
      record(
        'fail',
        `Install (${cmd})`,
        'failed — this usually means the terminal is not elevated. ' +
          'Re-run `pnpm doctor` from an Administrator terminal.',
      );
      return;
    }
  }
  record(
    'pass',
    'Auto-install',
    'build tools installed — restart your terminal so PATH updates take effect, then re-run `pnpm install`.',
  );
}

// --- Cross-platform checks ---
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 22) record('pass', 'Node', `v${process.versions.node}`);
else record('fail', 'Node', `v${process.versions.node} — need >= 22 (see .nvmrc).`);

const pnpmV = has('pnpm');
if (pnpmV) record('pass', 'pnpm', pnpmV);
else record('fail', 'pnpm', 'not found — run `corepack enable`.');

const gitV = has('git');
if (gitV) record('pass', 'git', gitV);
else record('fail', 'git', 'not found — install Git.');

const claudeV = has('claude');
if (claudeV) record('pass', 'Claude CLI', claudeV);
else
  record(
    'warn',
    'Claude CLI',
    'not found — needed at runtime: `npm install -g @anthropic-ai/claude-code`',
  );

// --- Windows-only checks ---
if (isWindows) {
  const py = has('py', ['--version']) || has('python', ['--version']);

  const vswhere = `${process.env['ProgramFiles(x86)']}\\Microsoft Visual Studio\\Installer\\vswhere.exe`;
  let hasVc = false;
  if (existsSync(vswhere)) {
    const r = run(vswhere, [
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ]);
    hasVc = r.status === 0 && r.stdout.trim().length > 0;
  }
  if (!hasVc) hasVc = has('cl', ['/?']) !== null;

  const missing = [];
  if (!py) missing.push('python');
  if (!hasVc) missing.push('vctools');

  if (missing.length === 0) {
    record('pass', 'Windows build tools', 'Python + MSVC C++ present');
  } else {
    record(
      'warn',
      'Windows build tools',
      `missing: ${missing.join(', ')} — attempting auto-install`,
    );
    autoInstallWindows(missing);
  }
}

// --- Summary ---
const icon = { pass: '✓', warn: '!', fail: '✗' };
console.log('\nDash environment check\n');
for (const r of results) {
  console.log(`  ${icon[r.status]} ${r.name}: ${r.detail}`);
}
console.log('');
process.exit(hardFailure ? 1 : 0);
```

- [ ] **Step 2: Wire `doctor` in package.json**

In `package.json`, add to the `scripts` block (place it after `"type-check"`):

```json
    "doctor": "node scripts/doctor.mjs",
```

- [ ] **Step 3: Run doctor and verify a healthy environment passes**

Run: `pnpm doctor`
Expected: a `Dash environment check` list. Node/pnpm/git show `✓`. On Windows with tools already installed, `Windows build tools` shows `✓ Python + MSVC C++ present`. Exit code 0 (run `echo $?` in bash / `$LASTEXITCODE` in PowerShell to confirm).

- [ ] **Step 4: Verify a hard failure exits non-zero**

Run (bash): `PATH= /usr/bin/env node scripts/doctor.mjs; echo "exit=$?"` (simulates missing git/pnpm)
Expected: git and/or pnpm show `✗` and `exit=1`.
(If this is awkward on your shell, instead temporarily rename the `git` lookup expectation in your head and just confirm the script prints `✗` for any genuinely-missing tool with a non-zero exit.)

- [ ] **Step 5: Commit**

```bash
git add scripts/doctor.mjs package.json
git commit -m "feat(setup): add pnpm doctor for prereq checks + Windows build-tool auto-install"
```

---

### Task 3: Version pinning (engines, engine-strict, packageManager)

**Files:**

- Modify: `package.json`
- Modify: `.npmrc`

- [ ] **Step 1: Confirm the local pnpm version to pin**

Run: `pnpm --version`
Expected: a version like `10.32.1`. Use that exact value in Step 2 as `pnpm@<version>`.

- [ ] **Step 2: Add `engines` and `packageManager` to package.json**

In `package.json`, add these two top-level keys (place `packageManager` right after `"main"`, and `engines` right after `"license"`). Use the exact pnpm version from Step 1:

```json
  "packageManager": "pnpm@10.32.1",
```

```json
  "engines": {
    "node": ">=22"
  },
```

- [ ] **Step 3: Enable strict engine checking in .npmrc**

In `.npmrc`, append the line:

```
engine-strict=true
```

The file should now read:

```
onlyBuiltDependencies[]=better-sqlite3
onlyBuiltDependencies[]=electron
onlyBuiltDependencies[]=esbuild
onlyBuiltDependencies[]=node-pty
shamefully-hoist=true
engine-strict=true
```

- [ ] **Step 4: Verify install still succeeds under correct Node**

Run: `pnpm install`
Expected: completes successfully (you are on Node 22+). The `postinstall` rebuild runs as in Task 1.

- [ ] **Step 5: Commit**

```bash
git add package.json .npmrc
git commit -m "chore(setup): pin Node engine and pnpm version, enable engine-strict"
```

---

### Task 4: Align CI workflow

**Files:**

- Modify: `.github/workflows/build.yml`

- [ ] **Step 1: Remove the explicit rebuild step from `build-mac`**

In `.github/workflows/build.yml`, in the `build-mac` job, delete these two lines (the `postinstall` hook now handles the rebuild during `pnpm install`):

```yaml
- name: Rebuild native modules for Electron
  run: pnpm exec electron-rebuild -f -w node-pty,better-sqlite3
```

- [ ] **Step 2: Remove the explicit rebuild step from `build-linux`**

In the `build-linux` job, delete the identical two lines:

```yaml
- name: Rebuild native modules for Electron
  run: pnpm exec electron-rebuild -f -w node-pty,better-sqlite3
```

- [ ] **Step 3: Drop the hardcoded pnpm version in `build-mac`**

In the `build-mac` job, change the pnpm setup step from:

```yaml
- uses: pnpm/action-setup@v4
  with:
    version: 9
```

to (it now reads the pinned version from `package.json`'s `packageManager`):

```yaml
- uses: pnpm/action-setup@v4
```

- [ ] **Step 4: Drop the hardcoded pnpm version in `build-linux`**

Apply the identical change in the `build-linux` job:

```yaml
- uses: pnpm/action-setup@v4
  with:
    version: 9
```

to:

```yaml
- uses: pnpm/action-setup@v4
```

- [ ] **Step 5: Validate the YAML still parses**

Run: `node -e "const f=require('fs').readFileSync('.github/workflows/build.yml','utf8'); if(/Rebuild native modules/.test(f)) throw new Error('rebuild step still present'); if(/version: 9/.test(f)) throw new Error('pnpm version 9 still present'); console.log('build.yml clean');"`
Expected: prints `build.yml clean`.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/build.yml
git commit -m "ci: drop explicit native rebuild step and pin pnpm via packageManager"
```

---

### Task 5: Documentation

**Files:**

- Modify: `README.md:31-43` (Prerequisites + Setup sections)
- Modify: `CLAUDE.md` (Commands block + Requirements section)

- [ ] **Step 1: Update README Prerequisites + Setup**

In `README.md`, replace the `## Prerequisites` and `## Setup` sections (currently lines 31–43) with:

````markdown
## Prerequisites

- Node.js 22+ (`corepack enable` to get the pinned pnpm automatically)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`npm install -g @anthropic-ai/claude-code`)
- Git

**Windows:** native modules (`better-sqlite3`, `node-pty`) compile from source, which needs
Python and the MSVC C++ build tools. Run `pnpm doctor` — it detects what's missing and
installs it for you via winget (or choco). Auto-install may prompt for Administrator rights;
run it from an elevated terminal if it reports a permission failure.

## Setup

```bash
pnpm install
```
````

That's it — `pnpm install` rebuilds the native modules for Electron automatically. If the
rebuild fails, run `pnpm doctor` to check your toolchain.

Windows is supported for development. Packaged releases target macOS arm64 and Linux x64.

````

- [ ] **Step 2: Update CLAUDE.md Commands block**

In `CLAUDE.md`, in the `## Commands` code block, replace these two lines:

```bash
pnpm install              # install deps
npx electron-rebuild -f -w node-pty,better-sqlite3  # rebuild native modules for Electron
````

with:

```bash
pnpm install              # install deps + auto-rebuild native modules for Electron
pnpm doctor               # check prerequisites (auto-installs Windows build tools)
```

- [ ] **Step 3: Update CLAUDE.md Requirements section**

In `CLAUDE.md`, in the `## Requirements` section, replace:

```
Node.js 22+ (`.nvmrc`), pnpm (`shamefully-hoist` in `.npmrc`), Claude Code CLI, Git. macOS arm64 or Linux x64.
```

with:

```
Node.js 22+ (`.nvmrc`), pnpm via Corepack (pinned in `packageManager`), Claude Code CLI, Git. Develop on macOS arm64, Linux x64, or Windows; packaged releases target macOS arm64 and Linux x64.
```

- [ ] **Step 4: Verify docs render and reference real commands**

Run: `node -e "const f=require('fs').readFileSync('README.md','utf8'); if(/electron-rebuild/.test(f)) throw new Error('stale electron-rebuild ref in README'); if(!/pnpm doctor/.test(f)) throw new Error('pnpm doctor not documented'); console.log('README ok');"`
Expected: prints `README ok`.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs(setup): single-command install, pnpm doctor, Windows dev support"
```

---

## Self-Review

**Spec coverage:**

- Pain 1 (forgetting rebuild) → Task 1 (postinstall). ✓
- Pain 2 (Windows toolchain, auto-install) → Task 2 (doctor + autoInstallWindows). ✓
- Pain 3 (onboarding one command) → Task 1 + Task 5 (docs). ✓
- Pain 4 (version drift / wrong Node) → Task 3 (engines, engine-strict, packageManager) + Task 4 (CI pnpm align). ✓
- Spec "CI stays green" → Task 4. ✓
- Spec separation (auto-install only from explicit `doctor`, never postinstall) → Task 1 has no install logic; Task 2 autoInstall only runs inside `doctor.mjs`. ✓

**Placeholder scan:** No TBD/TODO; all scripts and edits are shown in full. The `pnpm@10.32.1` value is confirmed from the live `pnpm --version` in this session and re-verified in Task 3 Step 1.

**Type/name consistency:** `record(status, name, detail)`, `run`, `has`, `autoInstallWindows(missing)` are defined once in `doctor.mjs` and referenced consistently. `missing` uses the tokens `'python'` / `'vctools'` in both the check block and `autoInstallWindows`. `DASH_SKIP_REBUILD` spelled identically in script and docs.
