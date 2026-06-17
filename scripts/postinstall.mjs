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
    '\n[postinstall] Native rebuild failed.\n' +
      '  - If the app is running, close it first — Windows locks the native .node files — then run `pnpm install` again.\n' +
      '  - Otherwise run `pnpm doctor` to check your build toolchain.\n'
  );
  process.exit(result.status ?? 1);
}
