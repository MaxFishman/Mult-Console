/*
 * Ableton Control Track — bridge
 *
 * Two jobs:
 *   1. Serve the web app (static files in /public).
 *   2. Relay between the UI (WebSocket) and AbletonOSC (OSC over UDP).
 *
 * Browsers/renderers cannot speak UDP/OSC, so every message the UI wants to
 * send to Ableton arrives here as JSON over a WebSocket and is re-emitted as an
 * OSC packet. Everything AbletonOSC sends back is forwarded to every connected
 * UI client as JSON.
 *
 * Usable two ways:
 *   - Standalone web server:  `node bridge/server.js`  (fixed port, open in a browser)
 *   - Embedded in Electron:   `require()` it and call `startBridge(opts)`
 */

const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const osc = require("osc");

const DEFAULTS = {
  httpPort: Number(process.env.PORT || 8080),
  httpHost: process.env.HTTP_HOST || "127.0.0.1",
  abletonHost: process.env.ABLETON_HOST || "127.0.0.1",
  sendPort: Number(process.env.ABLETON_SEND_PORT || 11000), // AbletonOSC input
  recvPort: Number(process.env.ABLETON_RECV_PORT || 11001), // AbletonOSC output
};

/**
 * Start the HTTP + WebSocket + OSC bridge.
 * @param {object} [opts] - overrides for DEFAULTS. Use httpPort 0 for a random free port.
 * @returns {Promise<{port:number, url:string, close:()=>Promise<void>}>}
 */
function startBridge(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };

  const app = express();
  app.use(express.static(path.join(__dirname, "..", "public")));
  const server = http.createServer(app);

  // --- WebSocket (UI <-> bridge) ---
  const wss = new WebSocketServer({ server });
  const clients = new Set();

  function broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  // --- OSC over UDP (bridge <-> AbletonOSC) ---
  const udp = new osc.UDPPort({
    localAddress: "127.0.0.1",
    localPort: cfg.recvPort,
    remoteAddress: cfg.abletonHost,
    remotePort: cfg.sendPort,
    metadata: false,
  });

  let abletonReady = false;

  udp.on("ready", () => {
    abletonReady = true;
    console.log(
      `[osc] listening on :${cfg.recvPort}, sending to ${cfg.abletonHost}:${cfg.sendPort}`
    );
    broadcast({ type: "bridge", abletonReady });
    safeSend("/live/song/get/num_tracks", []);
  });

  udp.on("message", (oscMsg) => {
    broadcast({ type: "osc", address: oscMsg.address, args: oscMsg.args || [] });
  });

  udp.on("error", (err) => {
    console.error("[osc] error:", err.message);
    broadcast({ type: "error", message: `OSC: ${err.message}` });
  });

  function safeSend(address, args) {
    if (!abletonReady) return;
    try {
      udp.send({ address, args: args || [] });
    } catch (err) {
      console.error("[osc] send failed:", err.message);
    }
  }

  wss.on("connection", (ws) => {
    clients.add(ws);
    console.log(`[ws] client connected (${clients.size} total)`);
    ws.send(JSON.stringify({ type: "bridge", abletonReady }));

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg && msg.type === "osc" && typeof msg.address === "string") {
        safeSend(msg.address, msg.args || []);
      } else if (msg && msg.type === "ui") {
        // UI-to-UI relay (e.g. main window -> tray popover): forward to the
        // other connected clients, never to Ableton.
        const data = JSON.stringify(msg);
        for (const c of clients) {
          if (c !== ws && c.readyState === c.OPEN) c.send(data);
        }
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      console.log(`[ws] client disconnected (${clients.size} total)`);
    });
    ws.on("error", () => clients.delete(ws));
  });

  // --- Boot ---
  udp.open();

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(cfg.httpPort, cfg.httpHost, () => {
      const port = server.address().port;
      const url = `http://${cfg.httpHost}:${port}`;
      console.log(`[http] web app at ${url}`);
      resolve({
        port,
        url,
        close: () =>
          new Promise((res) => {
            try { udp.close(); } catch {}
            for (const ws of clients) { try { ws.close(); } catch {} }
            server.close(() => res());
          }),
      });
    });
  });
}

module.exports = { startBridge, DEFAULTS };

// Standalone mode: `node bridge/server.js`
if (require.main === module) {
  startBridge()
    .then(({ url }) => {
      console.log(`\n  Ableton Control Track`);
      console.log(`  Web app:  ${url}`);
      console.log(`  Ableton:  OSC ${DEFAULTS.abletonHost} in:${DEFAULTS.sendPort} out:${DEFAULTS.recvPort}\n`);
    })
    .catch((err) => {
      console.error("Failed to start bridge:", err.message);
      process.exit(1);
    });
}
