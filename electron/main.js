/*
 * Ableton Control Track — Electron main process
 *
 * Starts the bridge (OSC/UDP + WebSocket + static UI) on a private localhost
 * port, then opens a window pointing at it. The UI loads over http://127.0.0.1
 * so the Web MIDI API works normally; we auto-grant the MIDI permission below.
 */

const {
  app, BrowserWindow, session, shell, Menu, ipcMain, dialog, Tray, nativeImage, screen,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { autoUpdater } = require("electron-updater");
const { startBridge } = require("../bridge/server");

// Product name (shown in the macOS app menu, About box, etc.).
app.setName("Mult Console");

let mainWindow = null;
let panelWindow = null;
let tray = null;
let bridge = null;
let updateDownloaded = false;

// Live status mirrored from the renderer; drives the tray.
const status = {
  bridge: false,
  ableton: false,
  midi: false,
  trackName: null,
  trackColor: "#ffb430",
};

// ---------------------------------------------------------------------------
// AbletonOSC auto-install
// ---------------------------------------------------------------------------

// Where the bundled copy of AbletonOSC lives (dev vs packaged app).
function bundledAbletonOscDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "AbletonOSC")
    : path.join(__dirname, "..", "vendor", "AbletonOSC");
}

// Default location of Live's user Remote Scripts folder, per platform.
function defaultRemoteScriptsDir() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Music", "Ableton", "User Library", "Remote Scripts");
  }
  if (process.platform === "win32") {
    return path.join(home, "Documents", "Ableton", "User Library", "Remote Scripts");
  }
  return path.join(home, "Ableton", "User Library", "Remote Scripts");
}

function abletonOscStatus(remoteScriptsDir = defaultRemoteScriptsDir()) {
  const target = path.join(remoteScriptsDir, "AbletonOSC");
  const parentExists = fs.existsSync(remoteScriptsDir);
  const installed = fs.existsSync(path.join(target, "__init__.py"));
  return { remoteScriptsDir, target, parentExists, installed };
}

function installAbletonOsc(remoteScriptsDir = defaultRemoteScriptsDir()) {
  const src = bundledAbletonOscDir();
  if (!fs.existsSync(path.join(src, "__init__.py"))) {
    return { ok: false, error: `Bundled AbletonOSC not found at ${src}` };
  }
  const target = path.join(remoteScriptsDir, "AbletonOSC");
  try {
    fs.mkdirSync(remoteScriptsDir, { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(src, target, { recursive: true });
    // macOS: strip the quarantine flag so Live will load the script.
    if (process.platform === "darwin") {
      try {
        require("child_process").execFileSync("xattr", ["-rd", "com.apple.quarantine", target]);
      } catch {
        /* non-fatal */
      }
    }
    return { ok: true, target, ...abletonOscStatus(remoteScriptsDir) };
  } catch (err) {
    return { ok: false, error: err.message, target };
  }
}

function registerIpc() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => sendUpdateStatus({ status: "checking" }));
  autoUpdater.on("update-available", (info) => {
    sendUpdateStatus({ status: "available", version: info.version });
  });
  autoUpdater.on("update-not-available", (info) => {
    sendUpdateStatus({ status: "current", version: info.version });
  });
  autoUpdater.on("download-progress", (progress) => {
    sendUpdateStatus({ status: "downloading", percent: progress.percent });
  });
  autoUpdater.on("update-downloaded", (info) => {
    updateDownloaded = true;
    sendUpdateStatus({ status: "downloaded", version: info.version });
  });
  autoUpdater.on("error", (err) => {
    sendUpdateStatus({ status: "error", message: err.message });
  });

  ipcMain.handle("updates:check", async () => {
    if (!app.isPackaged) return { status: "unavailable" };
    try {
      await autoUpdater.checkForUpdates();
      return { status: "checking" };
    } catch (err) {
      sendUpdateStatus({ status: "error", message: err.message });
      return { status: "error", message: err.message };
    }
  });
  ipcMain.handle("updates:install", () => {
    if (!app.isPackaged || !updateDownloaded) return false;
    autoUpdater.quitAndInstall();
    return true;
  });

  ipcMain.handle("abletonosc:status", (_e, dir) => abletonOscStatus(dir || undefined));
  ipcMain.handle("abletonosc:install", (_e, dir) => installAbletonOsc(dir || undefined));
  ipcMain.handle("abletonosc:chooseFolder", async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "Select your Ableton 'Remote Scripts' folder",
      defaultPath: defaultRemoteScriptsDir(),
      properties: ["openDirectory", "createDirectory"],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle("abletonosc:reveal", (_e, dir) => {
    const { target } = abletonOscStatus(dir || undefined);
    shell.showItemInFolder(target);
    return true;
  });

  // Renderer pushes live connection/track status; mirror it into the tray.
  ipcMain.on("status:update", (_e, payload) => {
    Object.assign(status, payload || {});
    updateTray();
  });

  ipcMain.on("ui:open-main", () => {
    if (panelWindow) panelWindow.hide();
    showMainWindow();
  });

  ipcMain.on("ui:toggle-panel", () => togglePanel());

  // ---- Persistent mapping store (a JSON file in the app's data folder) ----
  const mappingsFile = () => path.join(app.getPath("userData"), "mappings.json");
  ipcMain.handle("mappings:load", () => {
    try {
      return JSON.parse(fs.readFileSync(mappingsFile(), "utf8"));
    } catch {
      return null;
    }
  });
  ipcMain.handle("mappings:save", (_e, data) => {
    try {
      fs.writeFileSync(mappingsFile(), JSON.stringify(data, null, 2));
      return true;
    } catch (err) {
      console.error("mappings save failed:", err.message);
      return false;
    }
  });

  // ---- Named presets ({ presets: [{id,name,mappings}], activeId }) ----
  const presetsFile = () => path.join(app.getPath("userData"), "presets.json");
  ipcMain.handle("presets:load", () => {
    try {
      return JSON.parse(fs.readFileSync(presetsFile(), "utf8"));
    } catch {
      return null;
    }
  });
  ipcMain.handle("presets:save", (_e, data) => {
    try {
      fs.writeFileSync(presetsFile(), JSON.stringify(data, null, 2));
      return true;
    } catch (err) {
      console.error("presets save failed:", err.message);
      return false;
    }
  });

  // Export one preset to a file the user chooses.
  ipcMain.handle("presets:export", async (_e, payload) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: "Export preset",
      defaultPath: `${(payload && payload.name) || "preset"}.json`,
      filters: [{ name: "Mult Console Preset", extensions: ["json"] }],
    });
    if (res.canceled || !res.filePath) return false;
    try {
      fs.writeFileSync(res.filePath, JSON.stringify(payload, null, 2));
      return true;
    } catch (err) {
      console.error("preset export failed:", err.message);
      return false;
    }
  });

  // Import a preset file the user chooses.
  ipcMain.handle("presets:import", async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "Import preset",
      properties: ["openFile"],
      filters: [{ name: "Mult Console Preset", extensions: ["json"] }],
    });
    if (res.canceled || !res.filePaths.length) return null;
    try {
      return JSON.parse(fs.readFileSync(res.filePaths[0], "utf8"));
    } catch (err) {
      console.error("preset import failed:", err.message);
      return null;
    }
  });
}

function sendUpdateStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("updates:status", status);
  }
}

// Use a STABLE localhost port so the UI origin (and its localStorage, where
// mappings live) persists across launches. Fall back through a few ports if
// one is busy, then to a random port as a last resort.
async function startBridgeStable() {
  const base = 48219;
  for (let i = 0; i < 12; i++) {
    try {
      return await startBridge({ httpPort: base + i, httpHost: "127.0.0.1" });
    } catch (err) {
      if (err && err.code === "EADDRINUSE") continue;
      throw err;
    }
  }
  return startBridge({ httpPort: 0, httpHost: "127.0.0.1" });
}

async function createWindow() {
  if (!bridge) {
    try {
      bridge = await startBridgeStable();
    } catch (err) {
      console.error("Bridge failed to start:", err);
    }
  }

  // Auto-grant MIDI (and sysex) so the renderer's requestMIDIAccess() succeeds.
  const grant = (permission) => permission === "midi" || permission === "midiSysex";
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(grant(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => grant(permission));

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: "#141414",
    title: "Mult Console",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Keep running full-speed when hidden to the tray, so MIDI keeps flowing.
      backgroundThrottling: false,
    },
  });

  // Open external links in the user's browser, not inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (bridge) {
    mainWindow.loadURL(bridge.url);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "public", "index.html"));
  }

  // Closing the window hides it to the tray instead of quitting, so the
  // mapping engine stays alive. Real quit goes through app.isQuitting.
  mainWindow.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------
// Tray (menu bar)
// ---------------------------------------------------------------------------
function dot(on) {
  return on ? "●" : "○";
}

// Build a monochrome template icon: a rounded-ish square, filled when connected,
// a hollow outline when not. 44px bitmap @2x => 22pt, the macOS menu-bar size.
// Template images are tinted automatically for light/dark menu bars.
function buildTrayIcon(filled) {
  const S = 44;
  const inset = 7; // padding around the glyph
  const t = 6; // outline thickness when hollow
  const buf = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const inSquare = x >= inset && x < S - inset && y >= inset && y < S - inset;
      let on = false;
      if (inSquare) {
        if (filled) {
          on = true;
        } else {
          const inInner =
            x >= inset + t && x < S - inset - t && y >= inset + t && y < S - inset - t;
          on = !inInner;
        }
      }
      // BGRA, black with coverage in alpha (template image).
      buf[i] = 0;
      buf[i + 1] = 0;
      buf[i + 2] = 0;
      buf[i + 3] = on ? 255 : 0;
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: S, height: S, scaleFactor: 2 });
  img.setTemplateImage(true);
  return img;
}

let trayIconFilled = null;
let trayIconHollow = null;

function updateTray() {
  if (!tray) return;
  if (!trayIconFilled) trayIconFilled = buildTrayIcon(true);
  if (!trayIconHollow) trayIconHollow = buildTrayIcon(false);
  // Menu-bar glyph: filled when Ableton is connected, hollow otherwise.
  tray.setImage(status.ableton ? trayIconFilled : trayIconHollow);
  // Short text label alongside the icon makes it findable in a crowded bar.
  tray.setTitle(" MC");
  tray.setToolTip(
    `Mult Console\nBridge ${status.bridge ? "on" : "off"} · ` +
      `Ableton ${status.ableton ? "connected" : "off"} · ` +
      `MIDI ${status.midi ? "ready" : "off"}` +
      (status.trackName ? `\nControlling: ${status.trackName}` : "")
  );

  const menu = Menu.buildFromTemplate([
    { label: "Mult Console", enabled: false },
    { type: "separator" },
    { label: `${dot(status.bridge)}  Bridge — ${status.bridge ? "connected" : "offline"}`, enabled: false },
    { label: `${dot(status.ableton)}  Ableton — ${status.ableton ? "connected" : "not connected"}`, enabled: false },
    { label: `${dot(status.midi)}  MIDI — ${status.midi ? "ready" : "no access"}`, enabled: false },
    { type: "separator" },
    {
      label: status.trackName ? `Controlling:  ${status.trackName}` : "No track selected",
      enabled: false,
    },
    { type: "separator" },
    { label: "Open Mult Console", click: showMainWindow },
    { label: "Quick panel…", click: () => togglePanel() },
    { label: "Refresh connection", click: () => mainWindow && mainWindow.webContents.send("ui:refresh") },
    { label: "Add control", click: () => { showMainWindow(); mainWindow && mainWindow.webContents.send("ui:add-control"); } },
    { label: "Setup…", click: () => { showMainWindow(); mainWindow && mainWindow.webContents.send("ui:open-setup"); } },
    { type: "separator" },
    { label: "Quit Mult Console", click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  // Right-click shows this menu; left-click toggles the popover (set below).
  tray.menu = menu;
}

function createTray() {
  try {
    tray = new Tray(buildTrayIcon(false));
    tray.setIgnoreDoubleClickEvents(true);
    tray.on("click", () => togglePanel());
    tray.on("right-click", () => tray.popUpContextMenu(tray.menu));
    updateTray();
  } catch (e) {
    console.error("[tray] failed to create:", e);
  }
}

// ---------------------------------------------------------------------------
// Popover panel (compact live view, anchored under the tray icon)
// ---------------------------------------------------------------------------
function createPanel() {
  panelWindow = new BrowserWindow({
    width: 320,
    height: 460,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#141414",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const target = bridge ? `${bridge.url}/panel.html` : path.join(__dirname, "..", "public", "panel.html");
  if (bridge) panelWindow.loadURL(target);
  else panelWindow.loadFile(target);

  panelWindow.on("blur", () => panelWindow && panelWindow.hide());
  panelWindow.on("closed", () => { panelWindow = null; });
}

function positionPanelUnderTray() {
  if (!panelWindow) return;
  const { width, height } = panelWindow.getBounds();
  const primary = screen.getPrimaryDisplay();
  const trayBounds = tray ? tray.getBounds() : { x: 0, y: 0, width: 0, height: 0 };

  // The tray reports sane bounds only when it has a visible menu-bar slot
  // (y near the top). On notch Macs where it's hidden, fall back to anchoring
  // the popover at the top-right of the work area so it's always on-screen.
  const trayVisible =
    trayBounds.height > 0 && trayBounds.y <= primary.workArea.y + 40;

  const display = trayVisible
    ? screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })
    : primary;

  let x, y;
  if (trayVisible) {
    x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
    y = Math.round(trayBounds.y + trayBounds.height + 4);
  } else {
    x = display.workArea.x + display.workArea.width - width - 10;
    y = display.workArea.y + 6;
  }
  const maxX = display.workArea.x + display.workArea.width - width - 8;
  x = Math.min(Math.max(display.workArea.x + 8, x), maxX);
  panelWindow.setPosition(x, y, false);
}

function togglePanel() {
  if (!panelWindow) createPanel();
  if (panelWindow.isVisible()) {
    panelWindow.hide();
  } else {
    positionPanelUnderTray();
    panelWindow.show();
    panelWindow.focus();
  }
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Quick Panel", accelerator: "CmdOrCtrl+K", click: () => togglePanel() },
        { label: "Refresh Connection", accelerator: "CmdOrCtrl+R", click: () => mainWindow && mainWindow.webContents.send("ui:refresh") },
        { label: "Show Mult Console Window", accelerator: "CmdOrCtrl+Shift+O", click: showMainWindow },
        { type: "separator" },
        { label: "Reload UI", click: () => mainWindow && mainWindow.webContents.reload() },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // Dock icon in dev (the packaged app uses the bundle icon automatically).
  if (process.platform === "darwin" && app.dock) {
    try {
      app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, "..", "build", "icon.png")));
    } catch {}
  }
  buildMenu();
  registerIpc();
  createWindow();
  createTray();
  if (app.isPackaged) setTimeout(() => autoUpdater.checkForUpdates().catch((err) => {
    sendUpdateStatus({ status: "error", message: err.message });
  }), 5000);

  app.on("activate", () => {
    // Dock click: bring the main window back from the tray.
    showMainWindow();
  });
});

// Hiding to the tray keeps the app alive with no visible window; don't quit.
app.on("window-all-closed", () => {});

app.on("before-quit", async () => {
  if (bridge) {
    try { await bridge.close(); } catch {}
    bridge = null;
  }
});
