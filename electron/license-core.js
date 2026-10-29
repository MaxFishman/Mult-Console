/*
 * License key format + verification — pure, no filesystem, no Electron.
 *
 * Shared by the app (verify, in the main process) and the dev keygen
 * (sign, in tools/). A key is three dot-separated parts:
 *
 *     MULT.<base64url(payloadJSON)>.<base64url(ed25519-signature)>
 *
 * The signature covers the exact payload JSON bytes. The payload is:
 *     { v:1, name, email, tier, iat, exp? }
 *   - tier: "solo" | "studio" | "site"
 *   - iat : issued-at, epoch seconds
 *   - exp : optional expiry, epoch seconds (omit for a perpetual license)
 *
 * base64url has no '.', so '.' is a safe separator.
 */
const crypto = require("crypto");

const PREFIX = "MULT";
const VERSION = 1;
const TIERS = ["solo", "studio", "site"];

function b64urlEncode(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

// Deterministic JSON (sorted keys) so the signed bytes are reproducible.
function canonicalJSON(obj) {
  const keys = Object.keys(obj).sort();
  return JSON.stringify(obj, keys);
}

// --- signing (dev / keygen side) ---
function makeKey(payload, privateKeyPem) {
  const full = { v: VERSION, ...payload };
  const json = canonicalJSON(full);
  const sig = crypto.sign(null, Buffer.from(json, "utf8"), privateKeyPem);
  return `${PREFIX}.${b64urlEncode(json)}.${b64urlEncode(sig)}`;
}

// --- parsing + verification (app side) ---
function parseKey(key) {
  const cleaned = String(key || "").trim().replace(/\s+/g, "");
  const parts = cleaned.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    throw new Error("Not a Mult Console license key.");
  }
  const json = b64urlDecode(parts[1]).toString("utf8");
  let payload;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new Error("License key is malformed.");
  }
  return { json, payload, sig: b64urlDecode(parts[2]) };
}

/**
 * Verify a key string against the bundled public key.
 * @param {string} key
 * @param {string|Buffer} publicKeyPem
 * @param {number} [nowSec] - current time (epoch seconds), for expiry checks.
 * @returns {{ok:true, payload:object} | {ok:false, error:string}}
 */
function verifyKey(key, publicKeyPem, nowSec) {
  let parsed;
  try {
    parsed = parseKey(key);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const { json, payload, sig } = parsed;

  let sigOk = false;
  try {
    sigOk = crypto.verify(null, Buffer.from(json, "utf8"), publicKeyPem, sig);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, error: "License signature is invalid." };

  if (payload.v !== VERSION) return { ok: false, error: "Unsupported license version." };
  if (!TIERS.includes(payload.tier)) return { ok: false, error: "Unknown license tier." };

  const now = typeof nowSec === "number" ? nowSec : Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && now > payload.exp) {
    return { ok: false, error: "This license has expired." };
  }
  return { ok: true, payload };
}

module.exports = { PREFIX, VERSION, TIERS, makeKey, parseKey, verifyKey, b64urlEncode, b64urlDecode, canonicalJSON };
