import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ── Stderr EPIPE Guard ───────────────────────────────────────
process.stderr.on('error', (err) => {
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') return;
  throw err;
});

// ── PATH Fix ──────────────────────────────────────────────────
function fixPath(): void {
  const currentPath = process.env.PATH || '';
  const additions: string[] = [];

  if (process.platform === 'darwin') {
    const home = os.homedir();
    additions.push(
      path.join(home, '.local/bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    );
    // Try to get login shell PATH
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { execSync } = require('child_process');
      const shellPath = execSync('zsh -ilc "echo $PATH"', {
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
      if (shellPath) {
        additions.push(...shellPath.split(':'));
      }
    } catch {
      // Ignore — best effort
    }
  } else if (process.platform === 'linux') {
    const home = os.homedir();
    additions.push(
      path.join(home, '.nvm/versions/node/*/bin'),
      path.join(home, '.npm-global/bin'),
      path.join(home, '.local/bin'),
      '/usr/local/bin',
    );
  }

  const pathSet = new Set(currentPath.split(':'));
  for (const p of additions) {
    pathSet.add(p);
  }
  process.env.PATH = [...pathSet].join(':');
}

fixPath();

// ── Single Instance Lock ──────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// ── App Ready ─────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;

app.whenReady().then(async () => {
  // Initialize database
  const { DatabaseService } = await import('./services/DatabaseService');
  await DatabaseService.initialize();

  // Start hook server (must be ready before any PTY spawns)
  const { hookServer } = await import('./services/HookServer');
  await hookServer.start();

  // Register IPC handlers
  const { registerAllIpc } = await import('./ipc');
  registerAllIpc();

  // Create main window
  const { createWindow } = await import('./window');
  mainWindow = createWindow();

  // Kill PTYs owned by this window on close (CMD+W on macOS)
  mainWindow.on('close', () => {
    import('./services/ptyManager').then(({ killByOwner }) => {
      killByOwner(mainWindow!.webContents);
    });
  });

  // Start activity monitor — must happen after window creation
  const { activityMonitor } = await import('./services/ActivityMonitor');
  activityMonitor.start(mainWindow.webContents);

  // Remote control service needs a sender for state change events
  const { remoteControlService } = await import('./services/remoteControlService');
  remoteControlService.setSender(mainWindow.webContents);

  // Initialize auto-updater (production only)
  if (!process.argv.includes('--dev')) {
    const { AutoUpdateService } = await import('./services/AutoUpdateService');
    AutoUpdateService.initialize(mainWindow);
  }

  // Cleanup orphaned reserve worktrees (background, non-blocking)
  setTimeout(async () => {
    try {
      const { worktreePoolService } = await import('./services/WorktreePoolService');
      await worktreePoolService.cleanupOrphanedReserves();
    } catch {
      // Best effort
    }
  }, 2000);

  // Detect Claude CLI (cache for settings UI)
  loadCustomClaudePath();
  detectClaudeCli();
});

// ── Claude CLI Detection ──────────────────────────────────────
export let claudeCliCache: { installed: boolean; version: string | null; path: string | null } = {
  installed: false,
  version: null,
  path: null,
};

// Persisted custom Claude CLI path (stored in app data dir)
let customClaudeCliPath: string | null = null;

function getCustomClaudePathFile(): string {
  return path.join(app.getPath('userData'), 'claude-cli-path.json');
}

export function loadCustomClaudePath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(getCustomClaudePathFile(), 'utf-8'));
    customClaudeCliPath = data.path || null;
    return customClaudeCliPath;
  } catch {
    return null;
  }
}

export function saveCustomClaudePath(p: string | null): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs');
  customClaudeCliPath = p || null;
  if (p) {
    fs.writeFileSync(getCustomClaudePathFile(), JSON.stringify({ path: p }));
  } else {
    try {
      fs.unlinkSync(getCustomClaudePathFile());
    } catch {
      // Ignore
    }
  }
}

export function getCustomClaudePath(): string | null {
  return customClaudeCliPath;
}

export async function detectClaudeCli(): Promise<void> {
  // 1. Check custom path first
  if (customClaudeCliPath) {
    try {
      const { stdout: versionOut } = await execFileAsync(customClaudeCliPath, ['--version']);
      claudeCliCache = {
        installed: true,
        version: versionOut.trim(),
        path: customClaudeCliPath,
      };
      return;
    } catch {
      // Custom path invalid, fall through to auto-detect
    }
  }

  // 2. Auto-detect via which/where
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await execFileAsync(whichCmd, ['claude']);
    const claudePath = stdout.trim().split(/\r?\n/)[0]; // `where` may return multiple lines
    const { stdout: versionOut } = await execFileAsync(claudePath, ['--version']);
    claudeCliCache = {
      installed: true,
      version: versionOut.trim(),
      path: claudePath,
    };
  } catch {
    claudeCliCache = { installed: false, version: null, path: null };
  }
}

// ── App Lifecycle ─────────────────────────────────────────────
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const { createWindow } = await import('./window');
    mainWindow = createWindow();
    const { activityMonitor } = await import('./services/ActivityMonitor');
    activityMonitor.start(mainWindow.webContents);
    const { remoteControlService } = await import('./services/remoteControlService');
    remoteControlService.setSender(mainWindow.webContents);

    // Update auto-updater window reference
    if (!process.argv.includes('--dev')) {
      const { AutoUpdateService } = await import('./services/AutoUpdateService');
      AutoUpdateService.setWindow(mainWindow);
    }
  }
});

app.on('before-quit', async () => {
  // Signal renderer to save all terminal snapshots before we kill PTYs
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('app:beforeQuit');
      }
    }
    // Give renderer a moment to save snapshots
    await new Promise((resolve) => setTimeout(resolve, 200));
  } catch {
    // Best effort
  }

  // Stop auto-updater
  try {
    const { AutoUpdateService } = await import('./services/AutoUpdateService');
    AutoUpdateService.cleanup();
  } catch {
    // Best effort
  }

  // Stop hook server
  try {
    const { hookServer } = await import('./services/HookServer');
    hookServer.stop();
  } catch {
    // Best effort
  }

  // Kill all PTYs (also stops activity monitor)
  try {
    const { killAll } = await import('./services/ptyManager');
    killAll();
  } catch {
    // Best effort
  }

  // Stop all file watchers
  try {
    const { stopAll } = await import('./services/FileWatcherService');
    stopAll();
  } catch {
    // Best effort
  }
});
