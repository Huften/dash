import { BrowserWindow, shell } from 'electron';
import * as path from 'path';

const isDev = process.argv.includes('--dev');

export function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 800,
    title: 'Dash',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: false,
      preload: path.join(__dirname, 'preload.js'),
    },
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  if (isDev) {
    // Retry loading until Vite dev server is ready
    const devUrl = 'http://localhost:3000';
    const loadWithRetry = async (retries = 30, delay = 500) => {
      for (let i = 0; i < retries; i++) {
        try {
          await mainWindow.loadURL(devUrl);
          return;
        } catch {
          if (i < retries - 1) {
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }
      console.error(`[window] Failed to connect to ${devUrl} after ${retries} attempts`);
    };
    loadWithRetry();
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));
  }

  return mainWindow;
}
