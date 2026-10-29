#!/usr/bin/env node
/*
 * One-time: generate the Ed25519 signing keypair used for license keys.
 *
 *   node tools/gen-keypair.js
 *
 * Writes:
 *   tools/license-private.pem    <- SECRET. Signs licenses. Never commit. (gitignored)
 *   electron/license-public.pem  <- bundled with the app to verify licenses. Commit this.
 *
 * Refuses to overwrite an existing private key: regenerating it would
 * invalidate every license you have already sold. Delete it by hand if you
 * truly mean to rotate keys (and understand every old key then stops working).
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PRIV = path.join(__dirname, "license-private.pem");
const PUB = path.join(__dirname, "..", "electron", "license-public.pem");

if (fs.existsSync(PRIV)) {
  console.error(`Refusing to overwrite existing private key:\n  ${PRIV}\n` +
    `Regenerating it invalidates all issued licenses. Delete it manually to rotate.`);
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
fs.writeFileSync(PRIV, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
fs.writeFileSync(PUB, publicKey.export({ type: "spki", format: "pem" }));

console.log("Wrote:");
console.log("  (secret) " + PRIV);
console.log("  (bundle) " + PUB);
console.log("\nKeep the private key safe and OUT of git. The public key ships with the app.");
