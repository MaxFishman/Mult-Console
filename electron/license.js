/*
 * License + trial state (main process).
 *
 * - Trial: 14 days from first launch, recorded in userData/trial.json.
 * - License: a signed key the user activates, stored in userData/license.json
 *   and RE-VERIFIED against the bundled public key every launch (so editing the
 *   stored file by hand doesn't grant a license).
 *
 * Enforcement is "nag only": nothing is ever disabled. State drives a reminder
 * banner/modal in the UI. This is deliberately not tamper-proof — a client-side
 * check in a shipped app never can be — it just keeps honest users honest.
 */
const fs = require("fs");
const path = require("path");
const { verifyKey } = require("./license-core");

const TRIAL_DAYS = 14;
const DAY_MS = 86400000;

function createLicense({ userDataDir, publicKeyPem, isPackaged, now }) {
  const nowMs = typeof now === "function" ? now : () => Date.now();
  const licenseFile = path.join(userDataDir, "license.json");
  const trialFile = path.join(userDataDir, "trial.json");

  // Packaged builds enforce the trial; dev runs are treated as full unless
  // MULT_FORCE_TRIAL is set (handy for exercising the trial UI locally).
  const trialActive = isPackaged || !!process.env.MULT_FORCE_TRIAL;

  function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  }
  function writeJson(file, data) {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); return true; }
    catch { return false; }
  }

  // First launch stamps the trial start. Guard against a future/garbage value.
  function trialStart() {
    let rec = readJson(trialFile);
    const t = nowMs();
    if (!rec || typeof rec.start !== "number" || rec.start > t) {
      rec = { start: t };
      writeJson(trialFile, rec);
    }
    return rec.start;
  }

  // Returns the verified payload of the stored license, or null.
  function storedLicense() {
    const rec = readJson(licenseFile);
    if (!rec || typeof rec.key !== "string") return null;
    const res = verifyKey(rec.key, publicKeyPem, Math.floor(nowMs() / 1000));
    return res.ok ? res.payload : null;
  }

  function status() {
    const lic = storedLicense();
    if (lic) {
      return { state: "licensed", tier: lic.tier, name: lic.name, email: lic.email,
        trialDaysLeft: null, trialTotal: TRIAL_DAYS };
    }
    if (!trialActive) {
      return { state: "dev", tier: null, trialDaysLeft: null, trialTotal: TRIAL_DAYS };
    }
    const elapsed = nowMs() - trialStart();
    const daysLeft = Math.max(0, Math.ceil((TRIAL_DAYS * DAY_MS - elapsed) / DAY_MS));
    return {
      state: daysLeft > 0 ? "trial" : "expired",
      tier: null, trialDaysLeft: daysLeft, trialTotal: TRIAL_DAYS,
    };
  }

  // Verify a pasted key and, if valid, persist it. Returns { ok, status, error? }.
  function activate(key) {
    const res = verifyKey(key, publicKeyPem, Math.floor(nowMs() / 1000));
    if (!res.ok) return { ok: false, error: res.error, status: status() };
    writeJson(licenseFile, { key: String(key).trim(), activatedAt: nowMs() });
    return { ok: true, status: status() };
  }

  function deactivate() {
    try { fs.rmSync(licenseFile, { force: true }); } catch {}
    return { ok: true, status: status() };
  }

  return { status, activate, deactivate, TRIAL_DAYS };
}

module.exports = { createLicense, TRIAL_DAYS };
