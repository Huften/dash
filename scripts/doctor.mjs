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
        '      Build Tools: https://visualstudio.microsoft.com/visual-studio-build-tools/'
    );
    return;
  }

  // Full command strings run via cmd.exe. The winget VS workload needs its
  // --override value preserved as a single token; cmd does not re-quote args
  // array elements, so we build the command line by hand and quote it here.
  const commands = [];
  if (hasWinget) {
    if (missing.includes('python')) {
      commands.push(
        'winget install -e --id Python.Python.3.12 ' +
          '--accept-package-agreements --accept-source-agreements'
      );
    }
    if (missing.includes('vctools')) {
      commands.push(
        'winget install -e --id Microsoft.VisualStudio.2022.BuildTools ' +
          '--accept-package-agreements --accept-source-agreements ' +
          '--override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"'
      );
    }
  } else {
    const pkgs = [];
    if (missing.includes('python')) pkgs.push('python');
    if (missing.includes('vctools')) {
      pkgs.push('visualstudio2022buildtools', 'visualstudio2022-workload-vctools');
    }
    commands.push(`choco install ${pkgs.join(' ')} -y`);
  }

  for (const command of commands) {
    console.log(`\n[doctor] Installing: ${command}`);
    const r = spawnSync(command, { stdio: 'inherit', shell: true });
    if (r.status !== 0) {
      record(
        'fail',
        'Install',
        'failed — this usually means the terminal is not elevated. ' +
          'Re-run `pnpm doctor` from an Administrator terminal.'
      );
      return;
    }
  }
  record(
    'pass',
    'Auto-install',
    'build tools installed — restart your terminal so PATH updates take effect, then re-run `pnpm install`.'
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
    'not found — needed at runtime: `npm install -g @anthropic-ai/claude-code`'
  );

// --- Windows-only checks ---
if (isWindows) {
  const py = has('py', ['--version']) || has('python', ['--version']);

  // vswhere always lives under Program Files (x86) on 64-bit Windows. Prefer the
  // env var, but fall back to the well-known absolute path when it is absent
  // (some shells, e.g. Git Bash, don't expose ProgramFiles(x86)).
  const vswhere = [
    process.env['ProgramFiles(x86)'] &&
      `${process.env['ProgramFiles(x86)']}\\Microsoft Visual Studio\\Installer\\vswhere.exe`,
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe',
  ]
    .filter(Boolean)
    .find((p) => existsSync(p));
  let hasVc = false;
  if (vswhere) {
    // shell:false — vswhere is an absolute path with spaces; routing it through
    // cmd.exe (shell:true) splits it at the first space and fails.
    const r = run(vswhere, [
      '-products', '*',
      '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property', 'installationPath',
    ], { shell: false });
    hasVc = r.status === 0 && r.stdout.trim().length > 0;
  }
  if (!hasVc) hasVc = has('cl', ['/?']) !== null;

  const missing = [];
  if (!py) missing.push('python');
  if (!hasVc) missing.push('vctools');

  if (missing.length === 0) {
    record('pass', 'Windows build tools', 'Python + MSVC C++ present');
  } else {
    record('warn', 'Windows build tools', `missing: ${missing.join(', ')} — attempting auto-install`);
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
