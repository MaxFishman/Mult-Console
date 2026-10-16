/*
 * Preload runs in an isolated context before the page loads and exposes a
 * minimal, explicit API to the renderer.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  isElectron: true,
  platform: process.platform,

  // AbletonOSC auto-installer (filesystem work lives in the main process).
  abletonOSC: {
    status: (dir) => ipcRenderer.invoke("abletonosc:status", dir),
    install: (dir) => ipcRenderer.invoke("abletonosc:install", dir),
    chooseFolder: () => ipcRenderer.invoke("abletonosc:chooseFolder"),
    reveal: (dir) => ipcRenderer.invoke("abletonosc:reveal", dir),
  },

  // Push connection/track status up to the main process (drives the tray).
  reportStatus: (payload) => ipcRenderer.send("status:update", payload),

  // Application updates are checked/downloaded by the main process.
  updates: {
    check: () => ipcRenderer.invoke("updates:check"),
    install: () => ipcRenderer.invoke("updates:install"),
    onStatus: (cb) => ipcRenderer.on("updates:status", (_event, status) => cb(status)),
  },

  // Bring the main window forward (used by the popover panel).
  openMain: () => ipcRenderer.send("ui:open-main"),

  // Toggle the tray popover panel (used by the in-window Panel button).
  togglePanel: () => ipcRenderer.send("ui:toggle-panel"),

  // Persistent stores (JSON files in the app's data folder).
  store: {
    loadMappings: () => ipcRenderer.invoke("mappings:load"),
    saveMappings: (data) => ipcRenderer.invoke("mappings:save", data),
    loadPresets: () => ipcRenderer.invoke("presets:load"),
    savePresets: (data) => ipcRenderer.invoke("presets:save", data),
    exportPreset: (data) => ipcRenderer.invoke("presets:export", data),
    importPreset: () => ipcRenderer.invoke("presets:import"),
  },

  // Main process -> renderer commands triggered from the tray/app menu.
  onOpenSetup: (cb) => ipcRenderer.on("ui:open-setup", () => cb()),
  onAddControl: (cb) => ipcRenderer.on("ui:add-control", () => cb()),
  onRefresh: (cb) => ipcRenderer.on("ui:refresh", () => cb()),
});
