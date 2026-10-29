/*
 * Ableton Control Track — browser app
 *
 * Reads a MIDI controller via the Web MIDI API, and routes each control to a
 * device-parameter "slot" on whichever Ableton track is currently selected.
 * Talks to Live through the bridge (WebSocket) -> AbletonOSC (OSC/UDP).
 *
 * Key idea: a mapping stores a *slot* (device index + parameter index, or a
 * parameter name to match), NOT a fixed track. When Live's selected track
 * changes, we re-resolve the slot against the new track — so one physical knob
 * controls "the same place" on every track.
 */

// ---------------------------------------------------------------------------
// Bridge connection
// ---------------------------------------------------------------------------
const WS_URL = `ws://${location.host}`;
let ws = null;
let wsReady = false;

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    wsReady = true;
    setPill("bridge", true);
    logMsg("out", "bridge connected");
    // Subscribe to Live's selected-track changes + fetch current state.
    oscSend("/live/view/start_listen/selected_track", []);
    oscSend("/live/view/get/selected_track", []);
    oscSend("/live/song/get/num_tracks", []);
    loadSong();
  };
  ws.onclose = () => {
    wsReady = false;
    setPill("bridge", false);
    setPill("ableton", false);
    logMsg("err", "bridge disconnected — retrying in 2s");
    setTimeout(connect, 2000);
  };
  ws.onerror = () => {};
  ws.onmessage = (ev) => handleBridgeMessage(JSON.parse(ev.data));
}

function oscSend(address, args) {
  if (!wsReady) return;
  ws.send(JSON.stringify({ type: "osc", address, args }));
}

function handleBridgeMessage(msg) {
  if (msg.type === "bridge") {
    setPill("ableton", !!msg.abletonReady);
    return;
  }
  if (msg.type === "error") {
    logMsg("err", msg.message);
    return;
  }
  if (msg.type === "osc") {
    setPill("ableton", true);
    handleOsc(msg.address, msg.args || []);
    return;
  }
  if (msg.type === "ui" && msg.kind === "request-sync") {
    // The popover panel just opened/connected — push current state to it.
    pushStatus();
    refreshAllMeters();
  }
}

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------
const state = {
  selectedTrack: null,
  trackName: "",
  trackColor: "#ffb430",
  numDevices: 0,
  // devices[deviceIndex] = { name, numParams, params: [{name, min, max, value}] }
  devices: [],
  // mixer of the selected track
  mixer: { volume: 0, panning: 0, mute: 0, solo: 0, arm: 0, sends: {} },
  // song/transport (global, not per-track)
  songTime: 0,
  songLength: 0,
  sig: { num: 4, den: 4 },
};

// Query global song state (signature + length + playhead position).
function loadSong() {
  oscSend("/live/song/get/signature_numerator", []);
  oscSend("/live/song/get/signature_denominator", []);
  oscSend("/live/song/get/song_length", []);
  oscSend("/live/song/get/current_song_time", []);
}

function resetTrackState() {
  state.numDevices = 0;
  state.devices = [];
  state.mixer = { volume: 0, panning: 0, mute: 0, solo: 0, arm: 0, sends: {} };
  resetTakeover();
}

// Fetch everything about the current track so controls + meters stay current.
function loadTrack(t) {
  resetTrackState();
  oscSend("/live/track/get/name", [t]);
  oscSend("/live/track/get/color", [t]);
  oscSend("/live/track/get/num_devices", [t]);
  // Mixer fields (so mixer-target controls have live values).
  oscSend("/live/track/get/volume", [t]);
  oscSend("/live/track/get/panning", [t]);
  oscSend("/live/track/get/mute", [t]);
  oscSend("/live/track/get/solo", [t]);
  oscSend("/live/track/get/arm", [t]);
  for (const idx of mappedSendIndices()) oscSend("/live/track/get/send", [t, idx]);
}

// Send indices referenced by any current mapping (so we only query those).
function mappedSendIndices() {
  const s = new Set();
  for (const m of mappings) {
    if (m.targetKind === "mixer" && m.field === "send") s.add(m.sendIndex || 0);
  }
  return s;
}

// AbletonOSC returns the track color as a packed 0xRRGGBB integer.
function applyTrackColor(colorInt) {
  const hex =
    typeof colorInt === "number"
      ? "#" + (colorInt & 0xffffff).toString(16).padStart(6, "0")
      : "#ffb430";
  state.trackColor = hex;
  document.documentElement.style.setProperty("--track-color", hex);
}

function loadDevice(t, d) {
  oscSend("/live/device/get/name", [t, d]);
  oscSend("/live/device/get/num_parameters", [t, d]);
  oscSend("/live/device/get/parameters/name", [t, d]);
  oscSend("/live/device/get/parameters/min", [t, d]);
  oscSend("/live/device/get/parameters/max", [t, d]);
  oscSend("/live/device/get/parameters/value", [t, d]);
}

function ensureDevice(i) {
  if (!state.devices[i]) {
    state.devices[i] = { name: `Device ${i + 1}`, numParams: 0, params: [] };
  }
  return state.devices[i];
}

function ensureParam(dev, i) {
  if (!dev.params[i]) dev.params[i] = { name: `Param ${i + 1}`, min: 0, max: 1, value: 0 };
  return dev.params[i];
}

// ---------------------------------------------------------------------------
// Handle replies from AbletonOSC.
// AbletonOSC echoes the ids you queried with as leading args, e.g.
//   /live/track/get/name           -> [trackId, name]
//   /live/track/get/num_devices    -> [trackId, count]
//   /live/device/get/name          -> [trackId, deviceId, name]
//   /live/device/get/parameters/*  -> [trackId, deviceId, v0, v1, ...]
//   /live/view/get/selected_track  -> [trackIndex]
// ---------------------------------------------------------------------------
function handleOsc(address, args) {
  switch (address) {
    case "/live/view/get/selected_track": {
      const t = args[0];
      if (t !== state.selectedTrack) {
        state.selectedTrack = t;
        logMsg("in", `selected track -> ${t}`);
        loadTrack(t);
        renderTrack();
      }
      break;
    }
    case "/live/song/get/num_tracks":
      logMsg("in", `set has ${args[0]} tracks`);
      break;
    case "/live/song/get/current_song_time":
      // Don't let incoming positions fight an in-progress scrub animation.
      if (scrubTarget == null) {
        state.songTime = args[0];
        refreshAllMeters();
      }
      break;
    case "/live/song/get/signature_numerator":
      state.sig.num = args[0];
      refreshAllMeters();
      break;
    case "/live/song/get/signature_denominator":
      state.sig.den = args[0];
      refreshAllMeters();
      break;
    case "/live/song/get/song_length":
      state.songLength = args[0];
      refreshAllMeters();
      break;
    case "/live/track/get/name": {
      if (args[0] === state.selectedTrack) {
        state.trackName = args[1];
        renderTrack();
      }
      break;
    }
    case "/live/track/get/color": {
      if (args[0] === state.selectedTrack) applyTrackColor(args[1]);
      break;
    }
    case "/live/track/get/volume":
    case "/live/track/get/panning":
    case "/live/track/get/mute":
    case "/live/track/get/solo":
    case "/live/track/get/arm": {
      if (args[0] === state.selectedTrack) {
        const field = address.split("/").pop(); // volume|panning|mute|solo|arm
        state.mixer[field] = args[1];
        refreshAllMeters();
        refreshAllLeds();
      }
      break;
    }
    case "/live/track/get/send": {
      // [trackId, sendId, value]
      if (args[0] === state.selectedTrack) {
        state.mixer.sends[args[1]] = args[2];
        refreshAllMeters();
      }
      break;
    }
    case "/live/track/get/num_devices": {
      if (args[0] === state.selectedTrack) {
        state.numDevices = args[1];
        for (let d = 0; d < state.numDevices; d++) {
          ensureDevice(d);
          loadDevice(state.selectedTrack, d);
        }
        renderTrack();
        refreshAllMappingOptions();
      }
      break;
    }
    case "/live/device/get/name": {
      if (args[0] === state.selectedTrack) {
        ensureDevice(args[1]).name = args[2];
        refreshAllMappingOptions();
      }
      break;
    }
    case "/live/device/get/num_parameters": {
      if (args[0] === state.selectedTrack) ensureDevice(args[1]).numParams = args[2];
      break;
    }
    case "/live/device/get/parameters/name":
      storeParamArray(args, "name");
      refreshAllMappingOptions();
      break;
    case "/live/device/get/parameters/min":
      storeParamArray(args, "min");
      break;
    case "/live/device/get/parameters/max":
      storeParamArray(args, "max");
      break;
    case "/live/device/get/parameters/value":
      storeParamArray(args, "value");
      refreshAllMeters();
      break;
    case "/live/device/get/parameter/value": {
      // [trackId, deviceId, paramId, value]
      if (args[0] === state.selectedTrack) {
        ensureParam(ensureDevice(args[1]), args[2]).value = args[3];
        refreshAllMeters();
      }
      break;
    }
    default:
      break;
  }
}

function storeParamArray(args, key) {
  const [t, d, ...values] = args;
  if (t !== state.selectedTrack) return;
  const dev = ensureDevice(d);
  values.forEach((v, i) => {
    ensureParam(dev, i)[key] = v;
  });
}

// ---------------------------------------------------------------------------
// Targets — what a mapping controls on the selected track.
// A resolved target exposes: continuous, min/max, value (current), label,
// setAddr + setArgs(value) for OSC, and setLocal(value) to update the cache.
// ---------------------------------------------------------------------------
const MIXER_FIELDS = {
  volume: { label: "Volume", continuous: true, min: 0, max: 1 },
  panning: { label: "Pan", continuous: true, min: -1, max: 1 },
  send: { label: "Send", continuous: true, min: 0, max: 1 },
  mute: { label: "Mute", continuous: false },
  solo: { label: "Solo", continuous: false },
  arm: { label: "Arm", continuous: false },
};

// Beats per bar from the current time signature (beat = quarter note).
function beatsPerBar() {
  return (state.sig.num || 4) * (4 / (state.sig.den || 4));
}
function barBeatString(timeBeats) {
  const bpb = beatsPerBar();
  const bar = Math.floor(timeBeats / bpb) + 1;
  const beat = Math.floor(timeBeats - (bar - 1) * bpb) + 1;
  return `${bar}.${beat}`;
}
function resolveTarget(m) {
  if (m.targetKind === "transport") {
    return {
      isScrub: true,
      continuous: true,
      min: 0, max: 1,
      value: state.songTime || 0,
      label: "Scrub · timeline",
      setLocal: () => {},
    };
  }

  const t = state.selectedTrack;
  if (t == null) return null;

  if (m.targetKind === "mixer") {
    const field = m.field || "volume";
    const meta = MIXER_FIELDS[field];
    if (!meta) return null;
    if (field === "send") {
      const idx = m.sendIndex || 0;
      return {
        continuous: true, min: 0, max: 1,
        value: state.mixer.sends[idx] ?? 0,
        label: `Send ${String.fromCharCode(65 + idx)}`,
        setAddr: "/live/track/set/send",
        setArgs: (v) => [t, idx, v],
        setLocal: (v) => { state.mixer.sends[idx] = v; },
      };
    }
    return {
      continuous: meta.continuous,
      min: meta.min ?? 0, max: meta.max ?? 1,
      value: state.mixer[field] ?? 0,
      label: meta.label,
      setAddr: `/live/track/set/${field}`,
      setArgs: (v) => [t, v],
      setLocal: (v) => { state.mixer[field] = v; },
    };
  }

  // default: device parameter
  const dev = state.devices[m.deviceIndex];
  if (!dev) return null;
  const param = dev.params[m.paramIndex];
  if (!param) return null;
  return {
    continuous: true, min: param.min, max: param.max,
    value: param.value,
    label: `${dev.name} · ${param.name}`,
    setAddr: "/live/device/set/parameter/value",
    setArgs: (v) => [t, m.deviceIndex, m.paramIndex, v],
    setLocal: (v) => { param.value = v; },
  };
}

function targetNorm(tg) {
  return tg.max === tg.min ? 0 : (tg.value - tg.min) / (tg.max - tg.min);
}

// ---------------------------------------------------------------------------
// Soft takeover (pickup): a control only engages once its incoming value
// catches the parameter's current value, so switching tracks doesn't jump.
// ---------------------------------------------------------------------------
const takeover = {};
function takeoverState(id) {
  return takeover[id] || (takeover[id] = { engaged: false, lastInput: null });
}
function resetTakeover() {
  for (const k in takeover) {
    takeover[k].engaged = false;
    takeover[k].lastInput = null;
  }
}

// Smooth scrub engine: knob movement nudges a target position (proportional to
// how far you turn); an eased animation glides the Arrangement playhead toward
// it each frame, so motion ramps in/out instead of jumping stepwise.
let scrubTarget = null;     // target song time in beats (null = idle)
let scrubAnimating = false;
const SCRUB_EASE = 0.28;    // 0..1 — higher = snappier, lower = more ramp

// Set an absolute target position (beats); the easing loop glides to it.
function scrubSetTarget(beats) {
  if (!isFinite(beats)) return;
  scrubTarget = Math.max(0, beats);
  if (!scrubAnimating) {
    scrubAnimating = true;
    requestAnimationFrame(scrubTick);
  }
}

function scrubTick() {
  if (scrubTarget == null) { scrubAnimating = false; return; }
  const cur = state.songTime || 0;
  const diff = scrubTarget - cur;
  let next;
  if (Math.abs(diff) < 0.01) {
    next = scrubTarget;
    scrubTarget = null; // settled
  } else {
    next = cur + diff * SCRUB_EASE;
  }
  state.songTime = Math.max(0, next);
  oscSend("/live/song/set/current_song_time", [state.songTime]);
  updateScrubMeters();
  if (scrubTarget == null) scrubAnimating = false;
  else requestAnimationFrame(scrubTick);
}

// Absolute position across the whole arrangement (0..1) — mirrors the knob.
function scrubPosNorm(timeBeats) {
  const len = state.songLength || 0;
  return len > 0 ? Math.max(0, Math.min(1, timeBeats / len)) : 0;
}

function updateScrubMeters() {
  for (const m of mappings) {
    if (m.targetKind === "transport") {
      updateMeter(m.id, scrubPosNorm(state.songTime), barBeatString(state.songTime));
    }
  }
}

// CC (knob/fader): 0–127 maps absolutely across the whole timeline, so the
// knob's ends line up with the start and end of the arrangement.
function applyScrub(m, midiValue) {
  const len = state.songLength || 0;
  if (len <= 0) return; // length unknown yet
  let norm = midiValue / 127;
  if (m.invert) norm = 1 - norm;

  // Optional soft takeover so grabbing the knob doesn't snap the playhead.
  if (m.pickup !== false && !takeoverState(m.id).engaged) {
    const curNorm = Math.max(0, Math.min(1, (state.songTime || 0) / len));
    const tk = takeoverState(m.id);
    const last = tk.lastInput;
    const crossed = last != null && (last - curNorm) * (norm - curNorm) <= 0;
    const near = Math.abs(norm - curNorm) <= 0.02;
    tk.lastInput = norm;
    if (!(crossed || near)) {
      markWaiting(m.id, norm);
      return;
    }
    tk.engaged = true;
    clearWaiting(m.id);
  }

  scrubSetTarget(norm * len);
}

// Absolute CC (fader/knob) -> continuous value, with optional pickup + invert.
function applyCC(m, midiValue) {
  const tg = resolveTarget(m);
  if (!tg) return;
  if (tg.isScrub) {
    applyScrub(m, midiValue);
    return;
  }
  let norm = midiValue / 127;
  if (m.invert) norm = 1 - norm;

  if (!tg.continuous) {
    // CC into a binary target: upper half = on.
    setValue(m, tg, norm >= 0.5 ? 1 : 0, norm >= 0.5 ? 1 : 0);
    return;
  }

  const curNorm = targetNorm(tg);
  if (m.pickup !== false && !takeoverState(m.id).engaged) {
    const tk = takeoverState(m.id);
    const last = tk.lastInput;
    const crossed = last != null && (last - curNorm) * (norm - curNorm) <= 0;
    const near = Math.abs(norm - curNorm) <= 0.02;
    tk.lastInput = norm;
    if (!(crossed || near)) {
      markWaiting(m.id, norm);
      return; // not caught yet — don't move the parameter
    }
    tk.engaged = true;
    clearWaiting(m.id);
  }

  const value = tg.min + norm * (tg.max - tg.min);
  setValue(m, tg, value, norm);
}

// Note (button) -> toggle/momentary on a binary or continuous target.
function applyNote(m, pressed) {
  const tg = resolveTarget(m);
  if (!tg) return;
  if (tg.isScrub) {
    // A button jumps the playhead to the start (or the end if inverted).
    if (!pressed) return;
    scrubSetTarget(m.invert ? state.songLength || 0 : 0);
    return;
  }
  const mode = m.buttonMode || "toggle";
  let on;
  if (mode === "toggle") {
    if (!pressed) return; // act on press only
    const cur = tg.continuous ? targetNorm(tg) >= 0.5 : tg.value >= 0.5;
    on = cur ? 0 : 1;
  } else {
    on = pressed ? 1 : 0;
  }
  if (tg.continuous) {
    const value = on ? tg.max : tg.min;
    setValue(m, tg, value, on);
  } else {
    setValue(m, tg, on, on);
  }
}

// Commit a value: send OSC, update cache, UI meter, and LED feedback.
function setValue(m, tg, value, norm) {
  tg.setLocal(value);
  oscSend(tg.setAddr, tg.setArgs(value));
  updateMeter(m.id, Math.max(0, Math.min(1, norm)), displayValue(tg, value));
  sendLed(m, norm >= 0.5);
}

// Binary targets read better as ON/OFF than 1.00/0.00.
function displayValue(tg, value) {
  if (tg.continuous) return value;
  return value >= 0.5 ? "ON" : "OFF";
}

// ---------------------------------------------------------------------------
// Web MIDI
// ---------------------------------------------------------------------------
let learningMappingId = null;

async function initMidi() {
  if (!navigator.requestMIDIAccess) {
    logMsg("err", "Web MIDI not supported in this browser (use Chrome/Edge).");
    return;
  }
  try {
    const access = await navigator.requestMIDIAccess({ sysex: false });
    setPill("midi", true);
    const attach = () => {
      for (const input of access.inputs.values()) input.onmidimessage = onMidi;
      midiOutputs = [...access.outputs.values()];
    };
    attach();
    access.onstatechange = attach;
    logMsg("out", "MIDI ready");
  } catch (e) {
    logMsg("err", "MIDI access denied");
  }
}

let midiOutputs = [];

function onMidi(e) {
  const [status, d1, d2] = e.data;
  const type = status & 0xf0;
  const channel = status & 0x0f;
  const isCC = type === 0xb0;
  const isNoteOn = type === 0x90 && d2 > 0;
  const isNoteOff = type === 0x80 || (type === 0x90 && d2 === 0);
  if (!isCC && !isNoteOn && !isNoteOff) return;

  // MIDI Learn: bind the next CC or note-on to the learning mapping.
  if (learningMappingId != null && (isCC || isNoteOn)) {
    const m = mappings.find((x) => x.id === learningMappingId);
    if (m) {
      if (isCC) {
        m.inputKind = "cc";
        m.cc = d1;
        m.channel = channel;
        delete m.note;
      } else {
        m.inputKind = "note";
        m.note = d1;
        m.channel = channel;
        delete m.cc;
      }
      saveMappings();
      renderMappings();
    }
    learningMappingId = null;
    renderLearnState();
    return;
  }

  for (const m of mappings) {
    const kind = m.inputKind || "cc";
    const chOk = m.channel == null || m.channel === channel;
    if (kind === "cc" && isCC && m.cc === d1 && chOk) {
      applyCC(m, d2);
    } else if (kind === "note" && m.note === d1 && chOk) {
      if (isNoteOn) applyNote(m, true);
      else if (isNoteOff && (m.buttonMode || "toggle") === "momentary") applyNote(m, false);
    }
  }
}

// ---------------------------------------------------------------------------
// LED feedback — mirror a button's on/off state back to the controller.
// ---------------------------------------------------------------------------
function sendLed(m, on) {
  if ((m.inputKind || "cc") !== "note" || m.note == null) return;
  const ch = m.channel || 0;
  const vel = on ? 127 : 0;
  for (const out of midiOutputs) {
    try {
      out.send([0x90 | ch, m.note, vel]);
    } catch {}
  }
}

function refreshAllLeds() {
  for (const m of mappings) {
    if ((m.inputKind || "cc") !== "note") continue;
    const tg = resolveTarget(m);
    if (!tg) continue;
    const on = tg.continuous ? targetNorm(tg) >= 0.5 : tg.value >= 0.5;
    sendLed(m, on);
  }
}

// ---------------------------------------------------------------------------
// Mappings model + persistence
// ---------------------------------------------------------------------------
let mappings = [];
let nextId = 1;

// Source of truth for persistence is a JSON file in the app's data folder
// (desktop). localStorage is kept as a mirror so the popover panel — which
// shares the web origin — can sync via its storage event, and as the fallback
// in browser mode.
async function loadMappings() {
  let data = null;
  if (window.desktop && window.desktop.store) {
    try {
      data = await window.desktop.store.loadMappings();
    } catch {}
  }
  if (!Array.isArray(data)) {
    try {
      data = JSON.parse(localStorage.getItem("act_mappings") || "[]");
    } catch {
      data = [];
    }
  }
  mappings = Array.isArray(data) ? data : [];
  nextId = mappings.reduce((m, x) => Math.max(m, x.id), 0) + 1;
  // Mirror to localStorage so the panel (same origin) sees it immediately,
  // and ensure the file store exists (migrates old localStorage-only presets).
  localStorage.setItem("act_mappings", JSON.stringify(mappings));
  if (window.desktop && window.desktop.store) {
    window.desktop.store.saveMappings(mappings);
  }
}

function saveMappings() {
  // Mirror the working set for the panel (mappings.json + localStorage)...
  localStorage.setItem("act_mappings", JSON.stringify(mappings));
  if (window.desktop && window.desktop.store) {
    window.desktop.store.saveMappings(mappings);
  }
  // ...and fold it into the active preset.
  const active = activePreset();
  if (active) {
    active.mappings = mappings;
    savePresets();
  }
}

// ---------------------------------------------------------------------------
// Named presets
// ---------------------------------------------------------------------------
let presetState = { presets: [], activeId: null };

function activePreset() {
  return (
    presetState.presets.find((p) => p.id === presetState.activeId) ||
    presetState.presets[0] ||
    null
  );
}

function nextPresetId() {
  const n = presetState.presets.reduce((m, p) => {
    const num = parseInt(String(p.id).replace(/\D/g, ""), 10) || 0;
    return Math.max(m, num);
  }, 0);
  return "p" + (n + 1);
}

async function loadPresets() {
  let data = null;
  if (window.desktop && window.desktop.store && window.desktop.store.loadPresets) {
    try {
      data = await window.desktop.store.loadPresets();
    } catch {}
  }
  if (!data) {
    try {
      data = JSON.parse(localStorage.getItem("act_presets") || "null");
    } catch {}
  }

  if (data && Array.isArray(data.presets) && data.presets.length) {
    presetState = { presets: data.presets, activeId: data.activeId || data.presets[0].id };
  } else {
    // First run: migrate any existing working mappings into a "Default" preset.
    await loadMappings();
    presetState = {
      presets: [{ id: "p1", name: "Default", mappings: mappings }],
      activeId: "p1",
    };
    savePresets();
  }

  const active = activePreset();
  mappings = active ? (active.mappings || []).map((m) => ({ ...m })) : [];
  nextId = mappings.reduce((m, x) => Math.max(m, x.id), 0) + 1;
}

function savePresets() {
  const active = activePreset();
  if (active) active.mappings = mappings;
  if (window.desktop && window.desktop.store && window.desktop.store.savePresets) {
    window.desktop.store.savePresets(presetState);
  }
  localStorage.setItem("act_presets", JSON.stringify(presetState));
}

function selectPreset(id) {
  const p = presetState.presets.find((x) => x.id === id);
  if (!p) return;
  presetState.activeId = id;
  mappings = (p.mappings || []).map((m) => ({ ...m }));
  nextId = mappings.reduce((m, x) => Math.max(m, x.id), 0) + 1;
  renderMappings();
  renderPresetBar();
  // Mirror the working set so the panel follows, then persist active selection.
  localStorage.setItem("act_mappings", JSON.stringify(mappings));
  if (window.desktop && window.desktop.store) window.desktop.store.saveMappings(mappings);
  savePresets();
  refreshAllMeters();
  logMsg("out", `preset: ${p.name}`);
}

async function newPreset() {
  const name = await askName("New preset", `Preset ${presetState.presets.length + 1}`);
  if (!name) return;
  const id = nextPresetId();
  presetState.presets.push({ id, name, mappings: [] });
  selectPreset(id);
}

async function duplicatePreset() {
  const active = activePreset();
  const name = await askName("Duplicate preset as", `${active ? active.name : "Preset"} copy`);
  if (!name) return;
  const id = nextPresetId();
  presetState.presets.push({ id, name, mappings: mappings.map((m) => ({ ...m })) });
  selectPreset(id);
}

async function renamePreset() {
  const active = activePreset();
  if (!active) return;
  const name = await askName("Rename preset", active.name);
  if (!name) return;
  active.name = name;
  savePresets();
  renderPresetBar();
}

function deletePreset() {
  const active = activePreset();
  if (!active) return;
  if (!confirm(`Delete preset "${active.name}"?`)) return;
  if (presetState.presets.length <= 1) {
    // Keep at least one preset — clear it instead of removing.
    active.mappings = [];
    mappings = [];
    renderMappings();
    savePresets();
    localStorage.setItem("act_mappings", "[]");
    if (window.desktop && window.desktop.store) window.desktop.store.saveMappings([]);
    refreshAllMeters();
    return;
  }
  presetState.presets = presetState.presets.filter((p) => p.id !== active.id);
  selectPreset(presetState.presets[0].id);
}

async function exportPreset() {
  const active = activePreset();
  if (!active) return;
  const payload = {
    _type: "mult-console-preset",
    version: 1,
    name: active.name,
    mappings: mappings,
  };
  if (window.desktop && window.desktop.store && window.desktop.store.exportPreset) {
    const ok = await window.desktop.store.exportPreset(payload);
    if (ok) logMsg("out", `exported preset: ${active.name}`);
  } else {
    // Browser fallback: trigger a download.
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${active.name}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}

async function importPreset() {
  let data = null;
  if (window.desktop && window.desktop.store && window.desktop.store.importPreset) {
    data = await window.desktop.store.importPreset();
  } else {
    data = await pickJsonFile();
  }
  if (!data) return;
  // Accept a single preset {name,mappings} or a full {presets:[...]} dump.
  const incoming = Array.isArray(data.presets) ? data.presets : [data];
  let lastId = null;
  for (const p of incoming) {
    if (!p || !Array.isArray(p.mappings)) continue;
    lastId = nextPresetId();
    presetState.presets.push({ id: lastId, name: p.name || "Imported", mappings: p.mappings });
  }
  if (lastId) {
    selectPreset(lastId);
    logMsg("out", `imported preset`);
  }
}

// Browser-mode file picker fallback for import.
function pickJsonFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(JSON.parse(reader.result));
        } catch {
          resolve(null);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  });
}

function renderPresetBar() {
  const sel = document.getElementById("preset-select");
  if (!sel) return;
  sel.innerHTML = "";
  for (const p of presetState.presets) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  sel.value = presetState.activeId;
}

// Promise-based name prompt (Electron blocks window.prompt).
function askName(title, value = "") {
  return new Promise((resolve) => {
    const modal = document.getElementById("name-modal");
    const input = document.getElementById("name-modal-input");
    const okBtn = document.getElementById("name-modal-ok");
    const cancelBtn = document.getElementById("name-modal-cancel");
    document.getElementById("name-modal-title").textContent = title;
    input.value = value;
    modal.hidden = false;
    input.focus();
    input.select();
    const finish = (val) => {
      modal.hidden = true;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      input.onkeydown = null;
      resolve(val);
    };
    okBtn.onclick = () => finish(input.value.trim() || null);
    cancelBtn.onclick = () => finish(null);
    input.onkeydown = (e) => {
      if (e.key === "Enter") okBtn.onclick();
      else if (e.key === "Escape") cancelBtn.onclick();
    };
  });
}

function addMapping() {
  mappings.push({
    id: nextId++,
    name: `Control ${mappings.length + 1}`,
    inputKind: "cc",
    cc: null,
    note: null,
    channel: null,
    buttonMode: "toggle",
    pickup: true,
    invert: false,
    targetKind: "device",
    deviceIndex: 0,
    paramIndex: 0,
    field: "volume",
    sendIndex: 0,
    scrubStep: "bar",
  });
  saveMappings();
  renderMappings();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const el = {
  mappings: document.getElementById("mappings"),
  empty: document.getElementById("mappings-empty"),
  trackName: document.getElementById("track-name"),
  trackSub: document.getElementById("track-sub"),
  log: document.getElementById("log"),
};

function renderTrack() {
  if (state.selectedTrack == null) {
    el.trackName.textContent = "No track";
    el.trackSub.textContent = "Open a Live set and click a track";
    return;
  }
  el.trackName.textContent = state.trackName || `Track ${state.selectedTrack + 1}`;
  el.trackSub.textContent = `index ${state.selectedTrack} · ${state.numDevices} device${
    state.numDevices === 1 ? "" : "s"
  }`;
  pushStatus();
}

function renderMappings() {
  el.mappings.innerHTML = "";
  el.empty.style.display = mappings.length ? "none" : "block";
  const tpl = document.getElementById("mapping-template");

  for (const m of mappings) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = m.id;

    const nameInput = node.querySelector(".map-name");
    nameInput.value = m.name;
    nameInput.oninput = () => {
      m.name = nameInput.value;
      saveMappings();
    };

    node.querySelector(".remove").onclick = () => {
      mappings = mappings.filter((x) => x.id !== m.id);
      saveMappings();
      renderMappings();
    };

    const learnBtn = node.querySelector(".learn");
    learnBtn.onclick = () => {
      learningMappingId = learningMappingId === m.id ? null : m.id;
      renderLearnState();
    };

    // Target kind (device vs mixer) + visibility of dependent fields.
    const targetSel = node.querySelector(".targetkind");
    targetSel.value = m.targetKind || "device";
    const applyVisibility = () => {
      const kind = m.targetKind || "device";
      const isMixer = kind === "mixer";
      const isDevice = kind === "device";
      const isTransport = kind === "transport";
      const isNote = (m.inputKind || "cc") === "note";
      node.querySelector(".device-field").hidden = !isDevice;
      node.querySelector(".param-field").hidden = !isDevice;
      node.querySelector(".mixer-field").hidden = !isMixer;
      node.querySelector(".send-field").hidden = !(isMixer && (m.field || "volume") === "send");
      node.querySelector(".transport-field").hidden = !isTransport;
      node.querySelector(".button-chk").hidden = !isNote;
      // pickup applies to continuous faders/knobs, including absolute scrub
      node.querySelector(".pickup-chk").hidden = isNote;
    };
    targetSel.onchange = () => {
      m.targetKind = targetSel.value;
      resetTakeover();
      saveMappings();
      applyVisibility();
      refreshAllMappingOptions();
      refreshAllMeters();
    };

    const deviceSel = node.querySelector(".device");
    deviceSel.onchange = () => {
      m.deviceIndex = Number(deviceSel.value);
      m.paramIndex = 0;
      resetTakeover();
      saveMappings();
      refreshAllMappingOptions();
    };

    const paramSel = node.querySelector(".param");
    paramSel.onchange = () => {
      m.paramIndex = Number(paramSel.value);
      resetTakeover();
      saveMappings();
    };

    const mixerSel = node.querySelector(".mixerfield");
    mixerSel.value = m.field || "volume";
    mixerSel.onchange = () => {
      m.field = mixerSel.value;
      resetTakeover();
      saveMappings();
      applyVisibility();
      if (state.selectedTrack != null && m.field === "send") {
        oscSend("/live/track/get/send", [state.selectedTrack, m.sendIndex || 0]);
      }
      refreshAllMeters();
    };

    const sendSel = node.querySelector(".sendindex");
    sendSel.value = String(m.sendIndex || 0);
    sendSel.onchange = () => {
      m.sendIndex = Number(sendSel.value);
      resetTakeover();
      saveMappings();
      if (state.selectedTrack != null) oscSend("/live/track/get/send", [state.selectedTrack, m.sendIndex]);
      refreshAllMeters();
    };

    const pickupChk = node.querySelector(".pickup");
    pickupChk.checked = m.pickup !== false;
    pickupChk.onchange = () => {
      m.pickup = pickupChk.checked;
      resetTakeover();
      saveMappings();
    };

    const invertChk = node.querySelector(".invert");
    invertChk.checked = !!m.invert;
    invertChk.onchange = () => {
      m.invert = invertChk.checked;
      saveMappings();
    };

    const buttonModeSel = node.querySelector(".buttonmode");
    buttonModeSel.value = m.buttonMode || "toggle";
    buttonModeSel.onchange = () => {
      m.buttonMode = buttonModeSel.value;
      saveMappings();
    };

    applyVisibility();
    el.mappings.appendChild(node);
  }
  refreshAllMappingOptions();
  renderLearnState();
  refreshAllMeters();
}

function renderLearnState() {
  for (const node of el.mappings.children) {
    const id = Number(node.dataset.id);
    const m = mappings.find((x) => x.id === id);
    const btn = node.querySelector(".learn");
    btn.dataset.learning = learningMappingId === id ? "1" : "0";
    btn.textContent = learningMappingId === id ? "Listening…" : "Learn";
    const readout = node.querySelector(".midi-readout");
    if (m && readout) {
      const ch = (m.channel ?? 0) + 1;
      if ((m.inputKind || "cc") === "note") {
        readout.textContent = m.note == null ? "unassigned" : `Note ${m.note} · ch ${ch}`;
      } else {
        readout.textContent = m.cc == null ? "unassigned" : `CC ${m.cc} · ch ${ch}`;
      }
    }
  }
}

// Populate device/param dropdowns from current track state.
function refreshAllMappingOptions() {
  for (const node of el.mappings.children) {
    const id = Number(node.dataset.id);
    const m = mappings.find((x) => x.id === id);
    if (!m) continue;

    const deviceSel = node.querySelector(".device");
    deviceSel.innerHTML = "";
    const devCount = Math.max(state.numDevices, m.deviceIndex + 1, 1);
    for (let d = 0; d < devCount; d++) {
      const dev = state.devices[d];
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = dev ? `${d + 1}. ${dev.name}` : `Slot ${d + 1} (empty)`;
      deviceSel.appendChild(opt);
    }
    deviceSel.value = String(m.deviceIndex);

    const paramSel = node.querySelector(".param");
    paramSel.innerHTML = "";
    const dev = state.devices[m.deviceIndex];
    const pCount = dev ? Math.max(dev.params.length, m.paramIndex + 1) : m.paramIndex + 1;
    for (let p = 0; p < pCount; p++) {
      const param = dev && dev.params[p];
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = param ? `${p}. ${param.name}` : `#${p}`;
      paramSel.appendChild(opt);
    }
    paramSel.value = String(m.paramIndex);
  }
}

function meterNode(mappingId) {
  for (const node of el.mappings.children) {
    if (Number(node.dataset.id) === mappingId) return node;
  }
  return null;
}

// Knob geometry: r=40 -> circumference 251.327; a 270° arc is 188.495.
const KNOB_CIRC = 251.327;
const KNOB_ARC = 188.495;

function updateMeter(mappingId, norm, value) {
  const node = meterNode(mappingId);
  if (!node) return;
  const clamped = Math.max(0, Math.min(1, norm));
  const valueArc = node.querySelector(".knob-value");
  const pointer = node.querySelector(".knob-pointer");
  if (valueArc) valueArc.style.strokeDasharray = `${clamped * KNOB_ARC} ${KNOB_CIRC}`;
  // Pointer sweeps 270°, from 7:30 (225°) clockwise through the top to 4:30.
  if (pointer) pointer.setAttribute("transform", `rotate(${225 + clamped * 270} 50 50)`);
  node.querySelector(".meter-text").textContent = formatValue(value);
  // Mirror the knob — and the parameter it's bound to — to the popover panel.
  if (wsReady) {
    const m = mappings.find((x) => x.id === mappingId);
    ws.send(
      JSON.stringify({
        type: "ui",
        kind: "knob",
        id: mappingId,
        norm: clamped,
        value,
        label: m ? mappingLabel(m) : null,
      })
    );
  }
}

// Human label for what a mapping currently controls, e.g. "Analog · Cutoff".
function mappingLabel(m) {
  const tg = resolveTarget(m);
  return tg ? tg.label : null;
}

function refreshAllMeters() {
  for (const m of mappings) {
    const tg = resolveTarget(m);
    if (!tg) continue;
    if (tg.isScrub) {
      updateMeter(m.id, scrubPosNorm(tg.value), barBeatString(tg.value));
    } else {
      updateMeter(m.id, Math.max(0, Math.min(1, targetNorm(tg))), displayValue(tg, tg.value));
    }
  }
  refreshAllLeds();
}

// Pickup "waiting to catch" indicator: shows a ghost tick at the physical
// control's position until it crosses the parameter's current value.
function markWaiting(id, physNorm) {
  const node = meterNode(id);
  if (!node) return;
  node.classList.add("waiting");
  const ghost = node.querySelector(".knob-ghost");
  if (ghost) {
    ghost.setAttribute("transform", `rotate(${225 + physNorm * 270} 50 50)`);
    ghost.style.opacity = "1";
  }
}
function clearWaiting(id) {
  const node = meterNode(id);
  if (!node) return;
  node.classList.remove("waiting");
  const ghost = node.querySelector(".knob-ghost");
  if (ghost) ghost.style.opacity = "0";
}

function formatValue(v) {
  if (typeof v !== "number") return String(v);
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);
}

// ---------------------------------------------------------------------------
// Misc UI
// ---------------------------------------------------------------------------
function setPill(name, on) {
  const p = document.getElementById(`pill-${name}`);
  if (p) p.dataset.state = on ? "on" : "off";
  if (name === "ableton" || name === "midi") updateSetupSteps();
  pushStatus();
}

// Mirror current status to the tray (desktop) and the popover panel (over WS).
function pushStatus() {
  const pill = (id) => document.getElementById(id)?.dataset.state === "on";
  const payload = {
    bridge: pill("pill-bridge"),
    ableton: pill("pill-ableton"),
    midi: pill("pill-midi"),
    trackName:
      state.selectedTrack == null
        ? null
        : state.trackName || `Track ${state.selectedTrack + 1}`,
    trackColor: state.trackColor,
  };
  if (window.desktop && window.desktop.reportStatus) window.desktop.reportStatus(payload);
  if (wsReady) ws.send(JSON.stringify({ type: "ui", kind: "status", payload }));
}

function logMsg(kind, text) {
  const line = document.createElement("div");
  line.className = kind === "in" ? "in" : kind === "err" ? "err" : "out";
  const ts = new Date().toLocaleTimeString();
  line.textContent = `${ts}  ${text}`;
  el.log.appendChild(line);
  el.log.scrollTop = el.log.scrollHeight;
  while (el.log.childElementCount > 300) el.log.removeChild(el.log.firstChild);
}

document.getElementById("add-mapping").onclick = addMapping;
document.getElementById("clear-log").onclick = () => (el.log.innerHTML = "");

// Re-sync with Ableton: re-subscribe to selection changes and re-pull the
// current track + its devices. Use after switching Live projects or restarting
// Live, when the previous track/device state is stale.
function refreshConnection() {
  logMsg("out", "refreshing Ableton connection…");
  state.selectedTrack = null; // force a reload even if the new track has the same index
  resetTrackState();
  applyTrackColor(null);
  renderTrack();
  oscSend("/live/view/start_listen/selected_track", []);
  oscSend("/live/view/get/selected_track", []);
  oscSend("/live/song/get/num_tracks", []);
  loadSong();
}
document.getElementById("refresh-conn").onclick = refreshConnection;

// Preset bar wiring.
document.getElementById("preset-select").onchange = (e) => selectPreset(e.target.value);
document.getElementById("preset-new").onclick = newPreset;
document.getElementById("preset-duplicate").onclick = duplicatePreset;
document.getElementById("preset-rename").onclick = renamePreset;
document.getElementById("preset-delete").onclick = deletePreset;
document.getElementById("preset-export").onclick = exportPreset;
document.getElementById("preset-import").onclick = importPreset;

// ---------------------------------------------------------------------------
// Setup Guide + AbletonOSC auto-install
// ---------------------------------------------------------------------------
const osc = window.desktop && window.desktop.abletonOSC; // present only in the desktop app
let chosenRemoteDir = null;

const setup = {
  modal: document.getElementById("setup-modal"),
  installBtn: document.getElementById("install-osc"),
  chooseBtn: document.getElementById("choose-folder"),
  revealBtn: document.getElementById("reveal-osc"),
  note: document.getElementById("step-1-note"),
  actions: document.getElementById("step-1-actions"),
  manual: document.getElementById("step-1-manual"),
};

function setStepDone(n, done) {
  const node = document.getElementById(`step-${n}`);
  if (node) node.dataset.done = done ? "1" : "0";
}
function setStepState(n, text) {
  const s = document.getElementById(`step-${n}-state`);
  if (s) s.textContent = text;
}

// Reflect the live connection pills into the setup steps.
function updateSetupSteps() {
  const ab = document.getElementById("pill-ableton");
  if (ab) {
    const on = ab.dataset.state === "on";
    setStepDone(3, on);
    setStepState(3, on ? "connected" : "waiting…");
  }
  const midi = document.getElementById("pill-midi");
  if (midi) {
    const on = midi.dataset.state === "on";
    setStepDone(4, on);
    setStepState(4, on ? "ready" : "waiting…");
  }
}

async function refreshOscStatus() {
  if (!osc) {
    // Browser mode — no filesystem access; show manual instructions.
    setup.actions.hidden = true;
    setup.manual.hidden = false;
    setStepState(1, "manual");
    return;
  }
  const st = await osc.status(chosenRemoteDir);
  if (st.installed) {
    setStepDone(1, true);
    setStepState(1, "installed");
    setup.note.className = "step-note ok";
    setup.note.textContent = `Installed at ${st.target}`;
    setup.revealBtn.hidden = false;
    setup.installBtn.textContent = "Reinstall / update";
  } else {
    setStepDone(1, false);
    setStepState(1, "not installed");
    setup.note.className = "step-note";
    setup.note.textContent = st.parentExists
      ? `Will install into ${st.remoteScriptsDir}`
      : `Couldn't find ${st.remoteScriptsDir} — use “Choose folder…” to locate it.`;
    setup.installBtn.textContent = "Install AbletonOSC automatically";
  }
}

if (osc) {
  setup.installBtn.onclick = async () => {
    setup.installBtn.disabled = true;
    setup.installBtn.textContent = "Installing…";
    const res = await osc.install(chosenRemoteDir);
    setup.installBtn.disabled = false;
    if (res.ok) {
      setup.note.className = "step-note ok";
      setup.note.textContent = "Installed! Now restart Ableton Live (step 2), then enable it (step 3).";
      logMsg("out", `AbletonOSC installed at ${res.target}`);
    } else {
      setup.note.className = "step-note bad";
      setup.note.textContent = `Install failed: ${res.error}`;
      logMsg("err", `AbletonOSC install failed: ${res.error}`);
    }
    await refreshOscStatus();
  };
  setup.chooseBtn.onclick = async () => {
    const dir = await osc.chooseFolder();
    if (dir) {
      chosenRemoteDir = dir;
      await refreshOscStatus();
    }
  };
  setup.revealBtn.onclick = () => osc.reveal(chosenRemoteDir);
} else {
  setup.chooseBtn.hidden = true;
}

function openSetup() {
  setup.modal.hidden = false;
  refreshOscStatus();
  updateSetupSteps();
}
function closeSetup() {
  setup.modal.hidden = true;
}

document.getElementById("open-setup").onclick = openSetup;
document.getElementById("close-setup").onclick = closeSetup;
document.getElementById("done-setup").onclick = closeSetup;
setup.modal.addEventListener("click", (e) => {
  if (e.target === setup.modal) closeSetup();
});

// Auto-open the guide on first launch, or whenever AbletonOSC isn't installed.
function maybeAutoOpenSetup() {
  const seen = localStorage.getItem("act_setup_seen");
  if (!seen) {
    localStorage.setItem("act_setup_seen", "1");
    openSetup();
    return;
  }
  if (osc) {
    osc.status().then((st) => {
      if (!st.installed) openSetup();
    });
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// Tray/app-menu commands + Panel button (desktop only).
if (window.desktop) {
  if (window.desktop.onOpenSetup) window.desktop.onOpenSetup(() => openSetup());
  if (window.desktop.onAddControl) window.desktop.onAddControl(() => addMapping());
  if (window.desktop.onRefresh) window.desktop.onRefresh(() => refreshConnection());
  const updates = window.desktop.updates;
  const updateBtn = document.getElementById("check-updates");
  if (updates && updateBtn) {
    updateBtn.hidden = false;
    const checkForUpdates = async () => {
      updateBtn.textContent = "Checking…";
      updateBtn.disabled = true;
      const result = await updates.check();
      if (result.status === "error") showUpdateStatus(result);
    };
    const resetUpdateButton = () => {
      updateBtn.textContent = "Check for updates";
      updateBtn.disabled = false;
      updateBtn.title = "";
      updateBtn.onclick = checkForUpdates;
    };
    const showUpdateStatus = (update) => {
      if (update.status === "checking") {
        updateBtn.textContent = "Checking…";
        updateBtn.disabled = true;
      } else if (update.status === "available") {
        updateBtn.textContent = `Downloading ${update.version}…`;
        updateBtn.disabled = true;
      } else if (update.status === "downloading") {
        updateBtn.textContent = `Downloading ${Math.floor(update.percent)}%`;
        updateBtn.disabled = true;
      } else if (update.status === "downloaded") {
        updateBtn.textContent = `Restart to install ${update.version}`;
        updateBtn.disabled = false;
        updateBtn.onclick = () => updates.install();
      } else if (update.status === "current") {
        updateBtn.textContent = "Up to date";
        updateBtn.disabled = true;
        setTimeout(resetUpdateButton, 4000);
      } else if (update.status === "error") {
        updateBtn.textContent = "Update failed — retry";
        updateBtn.disabled = false;
        updateBtn.title = update.message || "";
        updateBtn.onclick = checkForUpdates;
      }
    };
    updateBtn.onclick = checkForUpdates;
    updates.onStatus(showUpdateStatus);
  }
  const panelBtn = document.getElementById("open-panel");
  if (panelBtn && window.desktop.togglePanel) {
    panelBtn.hidden = false;
    panelBtn.onclick = () => window.desktop.togglePanel();
  }
  const tracksBtn = document.getElementById("open-tracks");
  if (tracksBtn && window.desktop.openTracks) {
    tracksBtn.hidden = false;
    tracksBtn.onclick = () => window.desktop.openTracks();
  }
}

(async () => {
  await loadPresets();
  renderPresetBar();
  renderMappings();
  renderTrack();
  connect();
  initMidi();
  maybeAutoOpenSetup();
})();
