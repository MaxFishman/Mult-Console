# License tooling

Mult Console uses **offline, Ed25519-signed license keys**. You hold a private
signing key; the app bundles only the matching public key (`electron/license-public.pem`)
and verifies keys locally — no server, no network, no phone-home.

> Everything here uses Node's built-in `crypto`. No dependencies to install.

## One-time setup

Generate your signing keypair:

```bash
node tools/gen-keypair.js
```

This writes:

- `tools/license-private.pem` — **SECRET.** Signs licenses. Git-ignored. Back it up
  somewhere safe (a password manager / offline drive). If you lose it you can't
  issue keys that validate against the shipped public key; if it leaks, anyone
  can mint valid licenses.
- `electron/license-public.pem` — ships inside the app to verify keys. **Commit this.**

⚠️ Regenerating the keypair invalidates **every license already sold** (they were
signed by the old private key). The script refuses to overwrite an existing
private key for this reason.

## Issue a license (per sale)

```bash
node tools/gen-license.js --name "Jane Doe" --email jane@example.com --tier studio
```

- `--tier` — `solo` | `studio` | `site`
- `--days N` — optional; makes a **time-limited** key (e.g. a 30-day reviewer or
  educational license). Omit for a perpetual license.

It prints a key like:

```
MULT.<base64url-payload>.<base64url-signature>
```

Send that to the customer. They paste it into **Mult Console → License → Activate**.

## How verification works

The signed payload is `{ v, name, email, tier, iat, exp? }`. The app
(`electron/license.js` + `electron/license-core.js`) re-verifies the signature
against the bundled public key on **every launch**, so editing the stored
`license.json` by hand doesn't grant a license.

## Honest limitations

A client-side check in a shipped Electron app is **tamper-resistant, not
tamper-proof** — the `.asar` can be unpacked and the check patched out. This
scheme stops casual key-sharing and gives honest customers a clean activation
flow; it is not DRM against determined piracy (nothing client-side is). If you
later need revocation or hard seat limits, that requires the online-activation
model (a hosted license server).
