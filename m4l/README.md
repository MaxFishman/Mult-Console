# Mult Console — Max for Live edition

A native-Live rebuild of Mult Console as a single **Max for Live MIDI device**.
No Electron app, no bridge, no OSC, no AbletonOSC install — the device lives
inside Live and talks to the Live Object Model directly.

> Requires **Ableton Live Suite** (or Live + the Max for Live add-on). The
> desktop/OSC version remains the option for Intro/Standard editions.

## What's here

| File | Role |
|---|---|
| `code/mult-console.js` | The engine. Runs in a `[v8]` object. Direct port of the desktop app's logic (slot-follows-selection, soft-takeover/pickup, eased timeline scrub, LED feedback, MIDI learn) from OSC to `LiveAPI`. |
| `code/mult-ui.html` | The UI. The desktop web UI, re-pointed from WebSocket/OSC to the Max `jweb` bridge. Loaded in a `[jweb]` object. |
| `MultConsole.maxpat` | The device patch wiring MIDI in → engine ⇄ UI, plus the transport clock and LED MIDI out. |

## How it maps to the desktop version

Every OSC address the desktop app used has a direct Live API equivalent:

| Desktop (OSC via AbletonOSC) | M4L (`LiveAPI` path / property) |
|---|---|
| `/live/view/get/selected_track` + `start_listen` | observe `live_set view` property `selected_track` |
| `/live/track/get/name` · `color` · `num_devices` | `live_set view selected_track` → `get name/color`, `getcount devices` |
| `/live/device/get/parameters/{name,min,max,value}` | `live_set view selected_track devices D parameters P` → `get` |
| `/live/device/set/parameter/value` | same path → `set value` |
| `/live/track/{get,set}/{volume,panning}` | `… mixer_device {volume,panning}` → `get/set value` |
| `/live/track/{get,set}/send` | `… mixer_device sends N` → `get/set value` |
| `/live/track/{get,set}/{mute,solo,arm}` | `live_set view selected_track` → `get/set` property |
| `/live/song/{get,set}/current_song_time` | `live_set` → `get/set current_song_time` |
| `/live/song/get/signature_*` | `live_set` → `get signature_numerator/denominator` |
| `/live/song/get/song_length` | `live_set` → `get last_event_time` *(closest LOM equivalent)* |

Because the selected-track paths resolve live, the "map a slot, not a track"
behaviour needs no index bookkeeping — it falls out of the path itself.

## Assembling the device in Live

The code is complete; final assembly happens in Max (a `.amxd` is authored in
Max, not by hand). Two ways:

**A. Open the provided patch (fastest)**
1. In Live, drop a **Max MIDI Effect** onto a MIDI track.
2. Click its **Edit** (✎) button to open the Max editor.
3. In Max: **File → Open…** → `m4l/MultConsole.maxpat`. Select all
   (`Cmd/Ctrl+A`), copy, and paste into the device editor window. *(Max opens
   `.maxpat` as a normal patch; the device wrapper is the `.amxd` you're
   editing.)*
4. Make sure `code/mult-console.js` and `code/mult-ui.html` sit next to the
   device file (or add `m4l/code` to the Max search path:
   **Options → File Preferences**).
5. **File → Save** — Live saves it as a `.amxd`. Freeze it
   (**File → Freeze Device**) to bundle the `.js`/`.html` for sharing.

**B. Build it by hand** — recreate the objects in `MultConsole.maxpat`
(`v8 mult-console.js`, `jweb mult-ui.html`, `ctlin`/`notein` → `pak` →
`prepend` → the v8, `live.thisdevice` → `metro 16` → `t poll`, and the
`route led` → `unpack` → `noteout` LED path). The patch file is the reference
for every box and connection.

## Using it

1. Put the device on a MIDI track. Route your controller to that track (track
   input = your controller, Monitor = **In**), so its CCs/notes reach the device.
2. In the device UI: **+ Add control**, click **Learn**, wiggle a knob — bound.
3. Pick what it drives: a **device parameter**, a **mixer** field
   (volume/pan/send/mute/solo/arm), or **timeline scrub**.
4. Click any track in Live — the control now drives the equivalent spot there.
   **Pickup** stops values from jumping when you switch.

## Known adaptation points (verify in Max)

- **jweb bridge**: the UI uses `window.max.outlet(...)` / `window.max.bindInlet("toui", …)`.
  If your Max version exposes the bridge differently, adjust the `MX` block at
  the top of `mult-ui.html` — the rest of the UI is bridge-agnostic.
- **Song length for scrub** uses `last_event_time`. If your Live version reports
  it differently, set a fixed length in `loadSong()` in `mult-console.js`.
- **Preset persistence**: the engine emits `save <json>` on every change
  (routed to a `print` placeholder in the patch). To persist mapping sets with
  the Live preset, wire that outlet to a `[pattrstorage]` / `[js]` store and
  send the engine `ui {"cmd":"load","mappings":[…]}` on recall. The multi-preset
  bar from the desktop app can be rebuilt on top of that hook.
- **MIDI arg order**: the patch sends `cc <value> <num> <chan>` (value triggers,
  since `[ctlin]` emits it last) and `note <num> <vel> <chan>`. The engine's
  `cc()` / `note()` signatures match this — keep them in sync if you rewire.

## Status

Engine, UI, and patch are written and syntax-checked. They have **not** been run
inside Max/Live yet — assemble per the steps above and test with a controller on
a MIDI track. The desktop (OSC) app under the repo root is unchanged.
