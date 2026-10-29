#!/usr/bin/env node
/*
 * Issue a signed license key for a customer.
 *
 *   node tools/gen-license.js --name "Jane Doe" --email jane@example.com --tier studio
 *   node tools/gen-license.js --name "Lab" --email it@school.edu --tier site
 *   node tools/gen-license.js --name "Demo" --email d@x.com --tier solo --days 30   # time-limited
 *
 * Requires tools/license-private.pem (run tools/gen-keypair.js once first).
 * Prints the license key to paste into the app's Activate box.
 */
const fs = require("fs");
const path = require("path");
const { makeKey, TIERS } = require("../electron/license-core");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const name = arg("name");
const email = arg("email");
const tier = (arg("tier", "solo") || "").toLowerCase();
const days = arg("days"); // optional: makes a time-limited key

if (!name || !email) {
  console.error('Usage: node tools/gen-license.js --name "Full Name" --email addr --tier solo|studio|site [--days N]');
  process.exit(1);
}
if (!TIERS.includes(tier)) {
  console.error(`--tier must be one of: ${TIERS.join(", ")}`);
  process.exit(1);
}

const PRIV = path.join(__dirname, "license-private.pem");
if (!fs.existsSync(PRIV)) {
  console.error(`Missing private key: ${PRIV}\nRun:  node tools/gen-keypair.js`);
  process.exit(1);
}
const privateKeyPem = fs.readFileSync(PRIV, "utf8");

const iat = Math.floor(Date.now() / 1000);
const payload = { name, email, tier, iat };
if (days) payload.exp = iat + Math.round(Number(days) * 86400);

const key = makeKey(payload, privateKeyPem);

console.log(`\nTier:    ${tier}`);
console.log(`Name:    ${name}`);
console.log(`Email:   ${email}`);
console.log(`Issued:  ${new Date(iat * 1000).toISOString()}`);
if (payload.exp) console.log(`Expires: ${new Date(payload.exp * 1000).toISOString()}`);
console.log(`\nLicense key:\n\n${key}\n`);
