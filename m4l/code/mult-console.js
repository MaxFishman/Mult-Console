/*
 * Mult Console — Max for Live engine  (runs in a [v8 mult-console.js] object)
 *
 * This is the native-Live port of the desktop app's core. Where the Electron
 * app reached Live over OSC (bridge/server.js -> AbletonOSC), this reaches the
 * Live Object Model directly through the Max `LiveAPI` object. The mapping
 * model, soft-takeover (pickup), eased timeline scrub, LED feedback and preset
 * logic are translated 1:1 from public/app.js — only the transport layer and
 * the "resolve a slot on the selected track" step change.
 *
 * Why it's simpler than the OSC version: AbletonOSC made us track the selected
 * track index and re-query devices/params by id on every change. Here we just
 * build a LiveAPI on the path
 *     live_set view selected_track devices D parameters P
 * which *always* points at the currently-selected track. The slot-follows-
 * selection behaviour — the whole product — falls out of the path itself.
 *
 * Max I/O contract
 *   inlet 0 (messages in):
 *     cc  <num> <val> <chan>     MIDI control change   (from [ctlin])
 *     note <num> <vel> <chan>    MIDI note on/off      (from [notein]; vel 0 = off)
 *     ui  <jsonString>           a command from the jweb UI (see handleUi)
 *     poll                       refresh transport + meters (driven by a [metro])
 *     bang / loadbang            (re)initialise
 *   outlet 0 -> jweb UI:   toui <jsonString>
 *   outlet 1 -> MIDI out:  led  <note> <vel> <chan>   (for [makenote]/[midiout])
 *
 * Target: the `v8` object (Max 8.6+, ships with Live 12). ES2020 is fine.
 */

autowatch = 1;
inlets = 1;
outlets = 2;

const OUT_UI = 0;
const OUT_MIDI = 1;

// ---------------------------------------------------------------------------
// Live state  (mirror of app.js `state`)
// ---------------------------------------------------------------------------
const state = {
  trackName: "",
  trackColor: "#ffb430",
  numDevices: 0,
  // devices[d] = { name, params: [{ name, min, max }] } — values are read live.
  devices: [],
  songTime: 0,
  songLength: 0,
  sig: { num: 4, den: 4 },
};

// ---------------------------------------------------------------------------
// LiveAPI helpers.  Each returns a short-lived LiveAPI bound to a path. Paths
// containing "view selected_track" automatically follow the user's selection.
// ---------------------------------------------------------------------------
function apiSelectedTrack() {
  return new LiveAPI(null, "live_set view selected_track");
}
function apiSong() {
  return new LiveAPI(null, "live_set");
}
function apiDeviceParam(d, p) {
  return new LiveAPI(null, "live_set view selected_track devices " + d + " parameters " + p);
}
function apiMixerField(field) {
  // volume | panning -> mixer_device sub-parameter with a .value
  return new LiveAPI(null, "live_set view selected_track mixer_device " + field);
}
function apiSend(idx) {
  return new LiveAPI(null, "live_set view selected_track mixer_device sends " + idx);
}

// A LiveAPI with an invalid path reports id 0.
function apiValid(api) {
  return api && Number(api.id) !== 0;
}

// ---------------------------------------------------------------------------
// Observers — fire when Live changes underneath us.
// ---------------------------------------------------------------------------
let selObserver = null; // selected-track changed
let timeObserver = null; // playhead moved

function initObservers() {
  // Selected track: re-read the whole track when the user clicks a new one.
  selObserver = new LiveAPI(onSelectedTrackChanged, "live_set view");
  selObserver.property = "selected_track";

  // Playhead: keep scrub meters honest without polling too hard.
  timeObserver = new LiveAPI(onSongTimeChanged, "live_set");
  timeObserver.property = "current_song_time";
}

function onSelectedTrackChanged() {
  loadTrack();
  renderTrack();
}

function onSongTimeChanged(args) {
  // args = ["current_song_time", value]. Don't fight an in-progress scrub.
  if (scrubTarget == null) {
    state.songTime = Number(args[1]) || 0;
    refreshScrubMeters();
  }
}

// ---------------------------------------------------------------------------
// Load track / device / song state into the mirror (replaces the OSC loadTrack
// + loadDevice + loadSong round-trips; here the reads are synchronous).
// ---------------------------------------------------------------------------
function loadSong() {
  const song = apiSong();
  state.sig.num = Number(song.get("signature_numerator")) || 4;
  state.sig.den = Number(song.get("signature_denominator")) || 4;
  // LOM has no direct "song length"; last_event_time is the end of the
  // arrangement (what AbletonOSC's /song_length reported). Fall back if absent.
  const last = Number(song.get("last_event_time"));
  state.songLength = isFinite(last) && last > 0 ? last : 0;
  state.songTime = Number(song.get("current_song_time")) || 0;
}

function loadTrack() {
  state.numDevices = 0;
  state.devices = [];
  resetTakeover();

  const track = apiSelectedTrack();
  if (!apiValid(track)) {
    state.trackName = "";
    return;
  }
  state.trackName = String(track.get("name"));
  applyTrackColor(track.get("color"));

  const count = Number(track.getcount("devices")) || 0;
  state.numDevices = count;
  for (let d = 0; d < count; d++) loadDevice(d);
}

function loadDevice(d) {
  const dev = { name: "Device " + (d + 1), params: [] };
  const devApi = new LiveAPI(null, "live_set view selected_track devices " + d);
  if (apiValid(devApi)) {
    dev.name = String(devApi.get("name"));
    const pCount = Number(devApi.getcount("parameters")) || 0;
    for (let p = 0; p < pCount; p++) {
      const pa = apiDeviceParam(d, p);
      dev.params[p] = {
        name: apiValid(pa) ? String(pa.get("name")) : "Param " + (p + 1),
        min: apiValid(pa) ? Number(pa.get("min")) : 0,
        max: apiValid(pa) ? Number(pa.get("max")) : 1,
      };
    }
  }
  state.devices[d] = dev;
}

// AbletonOSC gave us a packed 0xRRGGBB int; LiveAPI "color" is the same.
function applyTrackColor(colorInt) {
  const n = Number(colorInt);
  state.trackColor = isFinite(n)
    ? "#" + (n & 0xffffff).toString(16).padStart(6, "0")
    : "#ffb430";
}

// ---------------------------------------------------------------------------
// Targets — what a mapping controls on the selected track.
// (Mirror of app.js resolveTarget, but each target reads/writes via LiveAPI.)
// A resolved target exposes: continuous, min, max, value(), label,
// set(value) to push to Live, and (for scrub) isScrub.
// ---------------------------------------------------------------------------
const MIXER_FIELDS = {
  volume: { label: "Volume", continuous: true, min: 0, max: 1 },
  panning: { label: "Pan", continuous: true, min: -1, max: 1 },
  send: { label: "Send", continuous: true, min: 0, max: 1 },
  mute: { label: "Mute", continuous: false },
  solo: { label: "Solo", continuous: false },
  arm: { label: "Arm", continuous: false },
};

function beatsPerBar() {
  return (state.sig.num || 4) * (4 / (state.sig.den || 4));
}
function barBeatString(timeBeats) {
  const bpb = beatsPerBar();
  const bar = Math.floor(timeBeats / bpb) + 1;
  const beat = Math.floor(timeBeats - (bar - 1) * bpb) + 1;
  return bar + "." + beat;
}

function resolveTarget(m) {
  if (m.targetKind === "transport") {
    return {
      isScrub: true,
      continuous: true,
      min: 0,
      max: 1,
      value: () => state.songTime || 0,
      label: "Scrub · timeline",
      set: () => {},
    };
  }

  const track = apiSelectedTrack();
  if (!apiValid(track)) return null;

  if (m.targetKind === "mixer") {
    const field = m.field || "volume";
    const meta = MIXER_FIELDS[field];
    if (!meta) return null;

    if (field === "send") {
      const idx = m.sendIndex || 0;
      const send = apiSend(idx);
      if (!apiValid(send)) return null;
      return {
        continuous: true,
        min: 0,
        max: 1,
        value: () => Number(send.get("value")) || 0,
        label: "Send " + String.fromCharCode(65 + idx),
        set: (v) => send.set("value", v),
      };
    }

    if (field === "volume" || field === "panning") {
      const mix = apiMixerField(field);
      if (!apiValid(mix)) return null;
      return {
        continuous: true,
        min: meta.min,
        max: meta.max,
        value: () => Number(mix.get("value")) || 0,
        label: meta.label,
        set: (v) => mix.set("value", v),
      };
    }

    // mute | solo | arm — plain 0/1 track properties.
    return {
      continuous: false,
      min: 0,
      max: 1,
      value: () => Number(track.get(field)) || 0,
      label: meta.label,
      set: (v) => track.set(field, v ? 1 : 0),
    };
  }

  // default: device parameter
  const meta = (state.devices[m.deviceIndex] || { params: [] }).params[m.paramIndex];
  const pa = apiDeviceParam(m.deviceIndex, m.paramIndex);
  if (!apiValid(pa)) return null;
  const devName = (state.devices[m.deviceIndex] || {}).name || "Device";
  const pName = meta ? meta.name : pa.get("name");
  return {
    continuous: true,
    min: meta ? meta.min : Number(pa.get("min")),
    max: meta ? meta.max : Number(pa.get("max")),
    value: () => Number(pa.get("value")) || 0,
    label: devName + " · " + pName,
    set: (v) => pa.set("value", v),
  };
}

function targetNorm(tg) {
  const v = tg.value();
  return tg.max === tg.min ? 0 : (v - tg.min) / (tg.max - tg.min);
}

// ---------------------------------------------------------------------------
// Soft takeover (pickup) — identical logic to app.js.
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

// ---------------------------------------------------------------------------
// Eased timeline scrub — ported from app.js, driven by the `poll` message
// (a [metro ~16ms] in the patch) instead of requestAnimationFrame.
// ---------------------------------------------------------------------------
let scrubTarget = null;
const SCRUB_EASE = 0.28;

function scrubSetTarget(beats) {
  if (!isFinite(beats)) return;
  scrubTarget = Math.max(0, beats);
}

function scrubTick() {
  if (scrubTarget == null) return;
  const cur = state.songTime || 0;
  const diff = scrubTarget - cur;
  let next;
  if (Math.abs(diff) < 0.01) {
    next = scrubTarget;
    scrubTarget = null;
  } else {
    next = cur + diff * SCRUB_EASE;
  }
  state.songTime = Math.max(0, next);
  apiSong().set("current_song_time", state.songTime);
  refreshScrubMeters();
}

function scrubPosNorm(timeBeats) {
  const len = state.songLength || 0;
  return len > 0 ? Math.max(0, Math.min(1, timeBeats / len)) : 0;
}

// ---------------------------------------------------------------------------
// Applying MIDI to a target — ported from app.js applyCC / applyNote / applyScrub.
// ---------------------------------------------------------------------------
function applyScrub(m, midiValue) {
  const len = state.songLength || 0;
  if (len <= 0) return;
  let norm = midiValue / 127;
  if (m.invert) norm = 1 - norm;

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
      return;
    }
    tk.engaged = true;
    clearWaiting(m.id);
  }

  const value = tg.min + norm * (tg.max - tg.min);
  setValue(m, tg, value, norm);
}

function applyNote(m, pressed) {
  const tg = resolveTarget(m);
  if (!tg) return;
  if (tg.isScrub) {
    if (!pressed) return;
    scrubSetTarget(m.invert ? state.songLength || 0 : 0);
    return;
  }
  const mode = m.buttonMode || "toggle";
  let on;
  if (mode === "toggle") {
    if (!pressed) return;
    const cur = tg.continuous ? targetNorm(tg) >= 0.5 : tg.value() >= 0.5;
    on = cur ? 0 : 1;
  } else {
    on = pressed ? 1 : 0;
  }
  if (tg.continuous) {
    setValue(m, tg, on ? tg.max : tg.min, on);
  } else {
    setValue(m, tg, on, on);
  }
}

// Commit a value: push to Live, update the UI meter, mirror LED feedback.
function setValue(m, tg, value, norm) {
  tg.set(value);
  updateMeter(m.id, Math.max(0, Math.min(1, norm)), displayValue(tg, value));
  sendLed(m, norm >= 0.5);
}

function displayValue(tg, value) {
  if (tg.continuous) return value;
  return value >= 0.5 ? "ON" : "OFF";
}

// ---------------------------------------------------------------------------
// MIDI input — called from the patch's [ctlin]/[notein].  Also handles Learn.
// ---------------------------------------------------------------------------
let learningMappingId = null;

// Arg order matches the patch's [ctlin]->[pak] wiring: value triggers (it is
// the last thing [ctlin] emits), so the message is `cc <value> <num> <chan>`.
function cc(val, num, chan) {
  num = Number(num); val = Number(val); chan = Number(chan) || 0;
  if (learningMappingId != null) {
    bindLearned("cc", num, chan);
    return;
  }
  for (const m of mappings) {
    if ((m.inputKind || "cc") === "cc" && m.cc === num && (m.channel == null || m.channel === chan)) {
      applyCC(m, val);
    }
  }
}

function note(num, vel, chan) {
  num = Number(num); vel = Number(vel); chan = Number(chan) || 0;
  const isOn = vel > 0;
  if (learningMappingId != null && isOn) {
    bindLearned("note", num, chan);
    return;
  }
  for (const m of mappings) {
    if ((m.inputKind || "cc") !== "note" || m.note !== num) continue;
    if (!(m.channel == null || m.channel === chan)) continue;
    if (isOn) applyNote(m, true);
    else if ((m.buttonMode || "toggle") === "momentary") applyNote(m, false);
  }
}

function bindLearned(kind, num, chan) {
  const m = mappings.find((x) => x.id === learningMappingId);
  if (m) {
    if (kind === "cc") {
      m.inputKind = "cc"; m.cc = num; m.channel = chan; delete m.note;
    } else {
      m.inputKind = "note"; m.note = num; m.channel = chan; delete m.cc;
    }
    saveMappings();
  }
  learningMappingId = null;
  pushMappings();
}

// ---------------------------------------------------------------------------
// LED feedback — mirror a button's state to the controller (via MIDI outlet).
// ---------------------------------------------------------------------------
function sendLed(m, on) {
  if ((m.inputKind || "cc") !== "note" || m.note == null) return;
  outlet(OUT_MIDI, "led", m.note, on ? 127 : 0, m.channel || 0);
}

function refreshAllLeds() {
  for (const m of mappings) {
    if ((m.inputKind || "cc") !== "note") continue;
    const tg = resolveTarget(m);
    if (!tg) continue;
    const on = tg.continuous ? targetNorm(tg) >= 0.5 : tg.value() >= 0.5;
    sendLed(m, on);
  }
}

// ---------------------------------------------------------------------------
// Mappings model.  Persistence is delegated to the Live device's stored state
// (the patch wires save/restore to pattrstorage / the Live preset); here we
// keep the working set and notify the UI.  See handleUi("load", ...).
// ---------------------------------------------------------------------------
let mappings = [];
let nextId = 1;

function addMapping() {
  mappings.push({
    id: nextId++,
    name: "Control " + (mappings.length + 1),
    inputKind: "cc",
    cc: null, note: null, channel: null,
    buttonMode: "toggle",
    pickup: true, invert: false,
    targetKind: "device",
    deviceIndex: 0, paramIndex: 0,
    field: "volume", sendIndex: 0,
  });
  saveMappings();
  pushMappings();
}

function removeMapping(id) {
  mappings = mappings.filter((x) => x.id !== id);
  saveMappings();
  pushMappings();
}

// Persist by handing the JSON to the patch (outlet -> pattrstorage / js global).
function saveMappings() {
  outlet(OUT_UI, "save", JSON.stringify(mappings));
}

// ---------------------------------------------------------------------------
// UI bridge (jweb).  The page sends `ui <json>`; we parse { cmd, ... }.
// We push state back with `toui <json>`.
// ---------------------------------------------------------------------------
function ui(jsonStr) {
  let msg;
  try { msg = JSON.parse(jsonStr); } catch (e) { return; }
  handleUi(msg);
}

function handleUi(msg) {
  switch (msg.cmd) {
    case "ready":
      // The page (re)connected — send it everything.
      pushTrack();
      pushMappings();
      refreshAllMeters();
      break;
    case "add":
      addMapping();
      break;
    case "remove":
      removeMapping(msg.id);
      break;
    case "update": {
      // Patch a single mapping's fields: { cmd:"update", id, patch:{...} }.
      const m = mappings.find((x) => x.id === msg.id);
      if (m) {
        Object.assign(m, msg.patch || {});
        resetTakeover();
        saveMappings();
        pushMappings();
        refreshAllMeters();
      }
      break;
    }
    case "learn":
      learningMappingId = learningMappingId === msg.id ? null : msg.id;
      toUi({ kind: "learn", id: learningMappingId });
      break;
    case "load":
      // Restore a mapping set (preset recall from the patch).
      mappings = Array.isArray(msg.mappings) ? msg.mappings : [];
      nextId = mappings.reduce((a, x) => Math.max(a, x.id), 0) + 1;
      pushMappings();
      refreshAllMeters();
      break;
    case "refresh":
      loadSong();
      loadTrack();
      renderTrack();
      break;
    default:
      break;
  }
}

function toUi(obj) {
  outlet(OUT_UI, "toui", JSON.stringify(obj));
}

function pushTrack() {
  toUi({
    kind: "track",
    name: state.trackName,
    color: state.trackColor,
    numDevices: state.numDevices,
    devices: state.devices, // { name, params:[{name,min,max}] }
  });
}

function renderTrack() {
  pushTrack();
  refreshAllMappingOptions();
  refreshAllMeters();
}

function refreshAllMappingOptions() {
  // The UI rebuilds device/param dropdowns from the pushed `track` message.
  pushTrack();
}

function pushMappings() {
  toUi({ kind: "mappings", mappings, learn: learningMappingId });
}

// ---------------------------------------------------------------------------
// Meters — push normalised positions + display text to the jweb UI.
// ---------------------------------------------------------------------------
function updateMeter(id, norm, value) {
  const m = mappings.find((x) => x.id === id);
  toUi({
    kind: "meter",
    id,
    norm: Math.max(0, Math.min(1, norm)),
    value,
    label: m ? mappingLabel(m) : null,
  });
}

function mappingLabel(m) {
  const tg = resolveTarget(m);
  return tg ? tg.label : null;
}

function refreshAllMeters() {
  for (const m of mappings) {
    const tg = resolveTarget(m);
    if (!tg) continue;
    if (tg.isScrub) {
      updateMeter(m.id, scrubPosNorm(tg.value()), barBeatString(tg.value()));
    } else {
      updateMeter(m.id, Math.max(0, Math.min(1, targetNorm(tg))), displayValue(tg, tg.value()));
    }
  }
  refreshAllLeds();
}

function refreshScrubMeters() {
  for (const m of mappings) {
    if (m.targetKind === "transport") {
      updateMeter(m.id, scrubPosNorm(state.songTime), barBeatString(state.songTime));
    }
  }
}

function markWaiting(id, physNorm) {
  toUi({ kind: "waiting", id, physNorm });
}
function clearWaiting(id) {
  toUi({ kind: "waiting", id, physNorm: null });
}

// ---------------------------------------------------------------------------
// Entry points called from the patch.
// ---------------------------------------------------------------------------
function poll() {
  // Driven by a [metro] — advances the scrub easing + keeps meters live.
  scrubTick();
}

function add() { addMapping(); }      // convenience for an "Add" button in the patch
function refresh() { handleUi({ cmd: "refresh" }); }

function loadbang() { init(); }
function bang() { init(); }

function init() {
  initObservers();
  loadSong();
  loadTrack();
  renderTrack();
  pushMappings();
}
