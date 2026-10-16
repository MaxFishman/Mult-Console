# Mult Console

Map **one** MIDI fader/knob to a device-parameter *slot* that follows whichever
track is **currently selected** in Ableton Live. Select a different track and
the same physical control now drives the same slot on that track's native
devices — no re-mapping.

```
MIDI controller ──(Web MIDI)──▶ Browser app ──(WebSocket)──▶ Node bridge ──(OSC/UDP)──▶ AbletonOSC ──▶ Live
                                     ▲                                                      │
                                     └───────────── selected track + parameter values ◀─────┘
```

## Install (macOS)

**Easiest — one line.** Paste this into Terminal; it downloads the right build,
installs it to Applications, clears the Gatekeeper flag, and opens it:

```bash
curl -fsSL https://raw.githubusercontent.com/MaxFishman/mult-console/main/install.sh | bash
```

**Or download the `.dmg`** from the
[latest release](https://github.com/MaxFishman/mult-console/releases/latest):
drag **Mult Console** to Applications, then open it **once** this way (the app
is ad-hoc signed but not Apple-notarized, so macOS asks the first time):

- **macOS 15 (Sequoia):** double-click it, then go to **System Settings →
  Privacy & Security → "Open Anyway."**
- **macOS 14 and earlier:** **right-click the app → Open → Open.**
- **If it says "damaged"** (macOS quarantines downloads), run once:
  ```bash
  xattr -cr "/Applications/Mult Console.app"
  ```

> Why the extra step? A silent, warning-free install requires Apple notarization
> (a paid Apple Developer account). This app is signed but not notarized — the
> one-line installer above does the un-quarantine step for you.

After installing, open the in-app **Setup** guide once to install AbletonOSC
into Ableton (requires **Live 11 or 12**).

## Why it's built this way

Ableton has no official network API, and browsers can't speak UDP/OSC. So:

- **AbletonOSC** (a free remote script) runs inside Live and exposes the Live
  Object Model over OSC.
- A tiny **Node bridge** translates between the browser's WebSocket and OSC/UDP.
- The browser reads your controller directly via the **Web MIDI API** and does
  the slot-follows-selection logic.

## Setup (in-app guide does this for you)

The desktop app opens a **Setup Guide** on first launch (reopen it any time with
the **Setup Guide** button, top-right). It walks through four steps and lights
each one green as it completes:

1. **Install AbletonOSC** — click **“Install AbletonOSC automatically.”** The
   app ships a bundled copy and installs it into Live's Remote Scripts folder
   for you (and clears the macOS quarantine flag so Live will load it). If your
   Live Library is in a non-standard place, use **Choose folder…** to point at
   your `Remote Scripts` directory.
2. **Restart Ableton Live** — Live only scans for Remote Scripts at launch.
3. **Enable the Control Surface** — in Live: **Settings → Link, Tempo & MIDI →
   MIDI**, set a **Control Surface** to **AbletonOSC** (Input/Output = None).
   You'll see “AbletonOSC: Listening for OSC on port 11000” in Live's status bar.
   This turns the **Ableton** status pill green.
4. **Connect your MIDI controller** — then add a mapping and hit **MIDI Learn**.

AbletonOSC listens on UDP **11000** and replies on **11001** — the defaults this
app uses.

### Manual install (browser mode only)

If you run the browser version (`npm run web`) instead of the desktop app, the
guide can't touch the filesystem, so install AbletonOSC by hand:

1. Download it: https://github.com/ideoforms/AbletonOSC
2. Copy the `AbletonOSC` folder into Live's Remote Scripts folder
   (macOS: `~/Music/Ableton/User Library/Remote Scripts/`), then do steps 2–4
   above.

### Why can't it be fully automatic?

The app installs the script and can re-run that any time, but **restarting Live**
and **selecting the Control Surface** have to be done by hand — those change
Live's own preferences, which an outside app shouldn't (and can't safely) edit.
A `.dmg`/installer also has no "run on install" hook on macOS, which is why the
script is installed on **first app launch** rather than at OS-install time.

## 2. Run the app

It ships as a **desktop app** (Electron). The bridge runs inside it — no
separate server, no browser needed.

```bash
npm install
npm start          # launches the Ableton Control Track desktop window
```

MIDI access is granted automatically. The three status pills (Bridge / Ableton
/ MIDI) should all go green.

### Browser mode (optional)

Prefer a browser tab, or want it headless? Run just the bridge:

```bash
npm run web        # serves at http://localhost:8080
```

Then open **http://localhost:8080** in **Chrome or Edge** (Web MIDI isn't in
Safari/Firefox).

## 2b. Build an installer to hand to users

```bash
npm run dist        # builds for your current OS into dist-installers/
npm run dist:mac    # macOS .dmg + .zip
npm run dist:win    # Windows .nsis installer
```

Output lands in `dist-installers/` — e.g. `Mult Console-1.0.0-arm64.dmg`
(drag the app to Applications) plus a matching `.zip`. On Windows you'd get an
`.exe` installer.

**Sharing the app (unsigned):** the build is not code-signed, so the first time
someone opens it macOS will block it with "Mult Console can't be opened." They
just **right-click the app → Open → Open** once, and it runs from then on.
(To remove that step entirely you'd sign + notarize with an Apple Developer
account.) The app icon is set from `build/icon.icns`.

### In-app updates

Packaged desktop builds check the latest GitHub release at startup and can also
check on demand with **Check for updates** in the app. Available updates download
in the background; select **Restart to install** when the download finishes.
Browser mode and development builds do not self-update.

To publish an update, increment the version in `package.json`, build with
`npm run dist` (or the platform-specific build command), and attach every
generated file in `dist-installers/` to the matching GitHub release. In
particular, keep the generated `latest*.yml` and `.blockmap` files alongside
their installers/ZIPs; the app uses this metadata to discover and download
updates. The build's GitHub Releases update provider is configured for this repo.

> Whoever runs it still needs AbletonOSC in Live — but the app installs that for
> them on first launch via the Setup guide (step 1). Only restarting Live and
> picking the Control Surface are manual.

## 3. Use it

1. Click **+ Add control**.
2. Click **Learn**, then wiggle the fader/knob you want to use — it binds.
3. Pick the target **device slot** and **parameter** — e.g. *Device 1 →
   parameter 2*. The slot follows the selected track by position, so the same
   control drives that slot on every track.
4. Click a track in Live. The control now targets that track. Move your knob and
   watch the parameter move; the on-screen knob reflects the live value.

Mappings are saved locally, so they persist across restarts.

## Menu bar app

Control Track lives in the macOS **menu bar**:

- The icon shows a filled square (**◼**) when Ableton is connected, hollow (**◻**)
  when not. Hover for a full status tooltip.
- **Left-click** opens a **popover panel** — a compact, live view of your mapped
  knobs that move in real time, plus the current track. Great for keeping an eye
  on things while the main window is closed.
- **Right-click** opens a menu with live status (Bridge / Ableton / MIDI), the
  track you're controlling, and quick actions: Open Control Track, Quick panel,
  Add control, Setup…, and Quit.
- **Closing the window hides it to the menu bar** rather than quitting, so your
  controls keep working. Use **Quit Control Track** from the menu to fully exit.

## Tips & notes

- **Macros:** point a mapping at an Instrument/Audio Rack's Macro parameters to
  drive several plugin params from one knob per track.
- **Multiple controls:** add as many mappings as you have knobs/faders. They all
  follow selection independently.
- Only **Control Change (CC)** messages are handled right now (the usual output
  of faders/knobs). Note messages are ignored.
- The **Activity** panel logs OSC/MIDI traffic — handy if something isn't moving.

## Configuration (env vars)

| Variable            | Default     | Meaning                              |
| ------------------- | ----------- | ------------------------------------ |
| `PORT`              | `8080`      | Web app / WebSocket port             |
| `ABLETON_HOST`      | `127.0.0.1` | Where AbletonOSC is running          |
| `ABLETON_SEND_PORT` | `11000`     | AbletonOSC input port                |
| `ABLETON_RECV_PORT` | `11001`     | AbletonOSC output port               |

## Troubleshooting

- **Ableton pill stays red:** AbletonOSC isn't selected as a Control Surface, or
  the ports differ. Check Live's MIDI settings and the status bar message.
- **MIDI pill red:** in the desktop app, make sure a controller is connected
  (it's granted automatically). In browser mode, you must use Chrome/Edge.
- **Values move the wrong amount:** parameters report their own min/max; the app
  scales 0–127 across that range. Stepped/quantized params will snap.
