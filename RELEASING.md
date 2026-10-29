# Releasing Mult Console

Installers are built by CI (`.github/workflows/release.yml`) — you don't build
them by hand. Two ways to run it:

## Cut a real release (publishes installers)

1. Bump the version in `package.json` (e.g. `1.0.1`).
2. Commit it.
3. Tag and push — the tag **must** match the version, prefixed with `v`:

   ```bash
   git commit -am "release: v1.0.1"
   git tag v1.0.1
   git push origin main --tags
   ```

CI then builds on macOS **and** Windows and uploads to a **draft** GitHub
Release (tag `v1.0.1`):

- `Mult Console-1.0.1-arm64.dmg` + `.zip` (Apple Silicon)
- `Mult Console-1.0.1-x64.dmg` + `.zip` (Intel Mac)
- `Mult Console Setup 1.0.1.exe` (Windows)
- `latest-mac.yml`, `latest.yml`, and `.blockmap` files — **the auto-updater
  needs these; leave them attached.**

4. Open the draft release on GitHub, confirm the files are attached, and click
   **Publish release**. The in-app updater only sees *published* releases.

> The release is a **draft** on purpose, so you review before it goes live.
> To publish automatically instead, change `releaseType` in `package.json`'s
> `build` config to `"release"`.

## Test the pipeline without releasing

Trigger it manually — this builds installers and attaches them as **workflow
artifacts** (nothing is published):

```bash
gh workflow run "Build & Release"
gh run watch        # or watch in the Actions tab
```

Download the artifacts from the run page to smoke-test the installers.

## Notes

- **Code signing / notarization** is not set up yet, so builds are unsigned —
  users get a first-run Gatekeeper/SmartScreen warning (the macOS one-line
  installer works around it). Adding an Apple Developer ID + Windows cert here
  later removes that, and the workflow is where those secrets would plug in.
- The build bundles AbletonOSC from `vendor/AbletonOSC` (see `extraResources`
  in `package.json`).
