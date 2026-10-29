/*
 * Mult Console — Track Navigator window.
 *
 * A standalone pop-out that lists every track in the current Live set and lets
 * you jump Live's selection by clicking a row. It shares the bridge WebSocket
 * with the main window (OSC replies are broadcast to every connected client),
 * so it needs no privileged access and no MIDI.
 *
 *   - On connect: ask Live how many tracks there are, then fetch each track's
 *     name + color by index. Those replies reuse the same handlers the main
 *     window already parses.
 *   - Listen for selected-track changes to highlight the active row.
 *   - Click a row -> /live/view/set/selected_track [i], which re-targets every
 *     mapped knob in the main window.
 */

let ws = null;
let numTracks = 0;
let selectedTrack = null;
const tracks = []; // tracks[i] = { name, color }

// --- bridge connection -----------------------------------------------------
function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => {
    // Subscribe to selection changes, then pull the full track list.
    oscSend("/live/view/start_listen/selected_track", []);
    oscSend("/live/view/get/selected_track", []);
    refresh();
  };
  ws.onclose = () => {
    setLed("ableton", false);
    setTimeout(connect, 2000);
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "osc") {
      setLed("ableton", true);
      handleOsc(msg.address, msg.args || []);
    }
  };
}

function oscSend(address, args) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "osc", address, args: args || [] }));
  }
}

// Ask for the track count; the reply triggers per-track name/color queries.
function refresh() {
  oscSend("/live/song/get/num_tracks", []);
}

function fetchAllTracks(n) {
  tracks.length = 0;
  for (let i = 0; i < n; i++) {
    tracks[i] = { name: null, color: null };
    oscSend("/live/track/get/name", [i]);
    oscSend("/live/track/get/color", [i]);
  }
}

// --- OSC handling ----------------------------------------------------------
function handleOsc(address, args) {
  switch (address) {
    case "/live/song/get/num_tracks": {
      numTracks = args[0] || 0;
      fetchAllTracks(numTracks);
      render();
      break;
    }
    case "/live/view/get/selected_track": {
      selectedTrack = args[0];
      render();
      break;
    }
    case "/live/track/get/name": {
      const [i, name] = args;
      if (tracks[i]) { tracks[i].name = name; render(); }
      break;
    }
    case "/live/track/get/color": {
      const [i, color] = args;
      if (tracks[i]) { tracks[i].color = colorToHex(color); render(); }
      break;
    }
  }
}

// AbletonOSC returns a track color as a packed 0xRRGGBB integer.
function colorToHex(colorInt) {
  return typeof colorInt === "number"
    ? "#" + (colorInt & 0xffffff).toString(16).padStart(6, "0")
    : "#6b6b6b";
}

function selectTrack(i) {
  oscSend("/live/view/set/selected_track", [i]);
  // Optimistic highlight; Live echoes the change back via the listener too.
  selectedTrack = i;
  render();
}

// --- rendering -------------------------------------------------------------
function setLed(name, on) {
  const el = document.getElementById(`pill-${name}`);
  if (el) el.dataset.state = on ? "on" : "off";
}

function render() {
  const host = document.getElementById("tracklist");
  const empty = document.getElementById("tracks-empty");
  const count = document.getElementById("tracks-count");
  const tpl = document.getElementById("track-row-template");

  count.textContent = numTracks ? `${numTracks}` : "";
  empty.hidden = numTracks > 0;
  if (!numTracks) { host.innerHTML = ""; return; }

  // Build rows once, then update in place so clicking doesn't rebuild the DOM.
  if (host.childElementCount !== numTracks) {
    host.innerHTML = "";
    for (let i = 0; i < numTracks; i++) {
      const row = tpl.content.firstElementChild.cloneNode(true);
      row.dataset.index = i;
      row.querySelector(".track-index").textContent = i + 1;
      row.onclick = () => selectTrack(i);
      host.appendChild(row);
    }
  }

  for (let i = 0; i < numTracks; i++) {
    const row = host.children[i];
    if (!row) continue;
    const t = tracks[i] || {};
    row.querySelector(".track-label").textContent = t.name || `Track ${i + 1}`;
    const swatch = row.querySelector(".track-swatch");
    swatch.style.background = t.color || "#6b6b6b";
    const isSel = i === selectedTrack;
    row.dataset.selected = isSel ? "1" : "0";
    if (isSel) row.style.setProperty("--track-color", t.color || "#ffb430");
    else row.style.removeProperty("--track-color");
  }
}

document.getElementById("tracks-refresh").onclick = () => {
  oscSend("/live/view/get/selected_track", []);
  refresh();
};

render();
connect();
