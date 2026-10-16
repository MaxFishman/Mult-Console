/*
 * Control Track — tray popover panel (slim, display-only).
 *
 * Shares the bridge WebSocket and localStorage with the main window. It does
 * NOT touch MIDI or send parameter changes — the main window owns the mapping
 * engine. The panel mirrors:
 *   - connection status + selected track  (via "ui:status" from the main window
 *     and OSC replies the bridge broadcasts)
 *   - knob positions                       (via "ui:knob" from the main window)
 */

const KNOB_CIRC = 251.327;
const KNOB_ARC = 188.495;

let ws = null;
let selectedTrack = null;

// --- bridge connection ---
function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => {
    setLed("bridge", true);
    // Ask the main window to push current status, knob values and labels.
    ws.send(JSON.stringify({ type: "ui", kind: "request-sync" }));
  };
  ws.onclose = () => {
    setLed("bridge", false);
    setTimeout(connect, 2000);
  };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}

function handle(msg) {
  if (msg.type === "osc") {
    setLed("ableton", true);
    handleOsc(msg.address, msg.args || []);
  } else if (msg.type === "ui") {
    if (msg.kind === "status") applyStatus(msg.payload);
    else if (msg.kind === "knob") setKnob(msg.id, msg.norm, msg.value, msg.label);
  }
}

function handleOsc(address, args) {
  if (address === "/live/view/get/selected_track") {
    selectedTrack = args[0];
  } else if (address === "/live/track/get/name" && args[0] === selectedTrack) {
    setTrackName(args[1]);
  } else if (address === "/live/track/get/color" && args[0] === selectedTrack) {
    applyColor(args[1]);
  }
}

function applyStatus(p) {
  if (!p) return;
  setLed("bridge", p.bridge);
  setLed("ableton", p.ableton);
  setLed("midi", p.midi);
  setTrackName(p.trackName || "No track");
  if (p.trackColor) {
    document.documentElement.style.setProperty("--track-color", p.trackColor);
    document.getElementById("strip-color").style.background = p.trackColor;
  }
}

function applyColor(colorInt) {
  const hex =
    typeof colorInt === "number"
      ? "#" + (colorInt & 0xffffff).toString(16).padStart(6, "0")
      : "#ffb430";
  document.documentElement.style.setProperty("--track-color", hex);
  document.getElementById("strip-color").style.background = hex;
}

// --- rendering ---
function setLed(name, on) {
  const el = document.getElementById(`pill-${name}`);
  if (el) el.dataset.state = on ? "on" : "off";
}

function setTrackName(name) {
  document.getElementById("track-name").textContent = name || "No track";
}

async function loadMappings() {
  if (window.desktop && window.desktop.store) {
    try {
      const d = await window.desktop.store.loadMappings();
      if (Array.isArray(d)) return d;
    } catch {}
  }
  try {
    return JSON.parse(localStorage.getItem("act_mappings") || "[]");
  } catch {
    return [];
  }
}

async function renderUnits() {
  const mappings = await loadMappings();
  const host = document.getElementById("panel-units");
  const tpl = document.getElementById("panel-unit-template");
  host.innerHTML = "";
  document.getElementById("panel-empty").hidden = mappings.length > 0;

  for (const m of mappings) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = m.id;
    node.querySelector(".panel-unit-name").textContent =
      m.name || `CC ${m.cc ?? "—"}`;
    host.appendChild(node);
  }
}

function setKnob(id, norm, value, label) {
  const node = document.querySelector(`.panel-unit[data-id="${id}"]`);
  if (!node) return;
  const clamped = Math.max(0, Math.min(1, norm));
  node.querySelector(".knob-value").style.strokeDasharray = `${clamped * KNOB_ARC} ${KNOB_CIRC}`;
  node.querySelector(".knob-pointer").setAttribute("transform", `rotate(${225 + clamped * 270} 50 50)`);
  node.querySelector(".meter-text").textContent =
    typeof value === "number" ? (Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2)) : value;
  // Show the actual parameter the control is bound to, not the generic name.
  if (label) node.querySelector(".panel-unit-name").textContent = label;
}

// Re-read mappings if the main window changes them (shared localStorage).
window.addEventListener("storage", (e) => {
  if (e.key === "act_mappings") renderUnits();
});

document.getElementById("open-main").onclick = () => {
  if (window.desktop && window.desktop.openMain) window.desktop.openMain();
};

renderUnits();
connect();
