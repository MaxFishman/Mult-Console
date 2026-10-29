# Local test run — Mult Console

A hands-on checklist to confirm the app actually works end-to-end on your
machine before shipping. Should take ~15 minutes. Tick the boxes; note anything
that misbehaves and report it back (what you did → what you expected → what
happened).

## 0. Prerequisites

- [ ] **Node 18+** installed (`node -v`)
- [ ] **Ableton Live 11 or 12** installed
- [ ] A **MIDI controller** with at least one knob or fader that sends CC
      (a cheap one is fine; even a software MIDI source works)
- [ ] This repo cloned, and you're in it: `cd ~/mult-console`

```bash
npm install        # first time only — pulls Electron etc. (~1–2 min)
```

---

## 1. Launch

```bash
npm start
```

- [ ] A window titled **Mult Console** opens
- [ ] A **menu-bar icon** appears (macOS: top-right; hollow ◻ until Ableton connects)
- [ ] The three status pills are visible top-right: **Bridge / Ableton / MIDI**
- [ ] **Bridge** pill is **green** within a second or two

> Dev builds show **no** trial nag (licensing only enforces in packaged builds).
> You'll force the trial UI on in step 6.

---

## 2. First-run setup (installs the Ableton bridge)

The **Setup** guide should open automatically on first launch (or click **Setup**).

- [ ] **Step 1 – Install AbletonOSC:** click **"Install AbletonOSC automatically"**
      → turns green, shows the install path under `…/Remote Scripts/AbletonOSC`
- [ ] **Step 2 – Restart Ableton Live:** quit and reopen Live (it only scans
      Remote Scripts at launch)
- [ ] **Step 3 – Enable the Control Surface:** in Live →
      **Settings → Link, Tempo & MIDI → MIDI** → set a **Control Surface** to
      **AbletonOSC** (Input/Output = None). Live's status bar shows
      *"AbletonOSC: Listening for OSC on port 11000."*
- [ ] Back in Mult Console, the **Ableton** pill turns **green** on its own
- [ ] The menu-bar icon becomes **filled ◼**

If the Ableton pill stays red: confirm AbletonOSC is the selected Control Surface
and that ports 11000/11001 aren't taken.

---

## 3. Core mapping (the whole point)

Open a Live set with **a few tracks**, each with an instrument/effect or just
stock devices.

- [ ] Click **+ Add control** → a knob unit appears
- [ ] Click **Learn**, then **move a knob/fader** on your controller
      → it binds; the MIDI readout shows e.g. `CC 74 · ch 1`
- [ ] Set **Target = Device parameter**, pick a **Device** and **Parameter**
- [ ] Select a **track** in Live, move your knob
      → the on-screen knob moves **and** the parameter moves in Live
- [ ] The **Activity** panel logs OSC/MIDI traffic
- [ ] **Follow-selection test:** click a **different** track in Live, move the
      same knob → it now drives the **same slot on that track** (no re-mapping) ✅
- [ ] Try **Target = Track mixer** (Volume / Pan / Send) on a mapping → works
- [ ] Toggle **Pickup** on, grab the knob → value **catches** (doesn't jump);
      the "·catch" hint shows until it passes the current position
- [ ] Toggle **Invert** → direction flips

---

## 4. Track Navigator (the new window)

- [ ] Press **⌘T** (or click **Tracks**, or tray → **Track list…**)
      → a pop-out lists **every track** with its name and Live **color**
- [ ] The **currently selected** track is highlighted (colored left bar + caret)
- [ ] **Click a different row** → that track becomes selected **in Live**
- [ ] Your mapped knobs now target that track (move a knob to confirm) ✅
- [ ] Select a track **in Live** instead → the highlight in the window follows
- [ ] Rename/recolor a track in Live, click **↻** → the list updates

---

## 5. Menu-bar panel & presets

- [ ] **Left-click** the tray icon → compact popover shows your knobs moving live
- [ ] **Right-click** the tray icon → status + quick actions menu
- [ ] Close the main window → it **hides to the tray** (controls keep working);
      reopen from the tray or dock
- [ ] Preset bar: **New**, **Duplicate**, **Rename**, **Export** (writes a file),
      **Import** (reads it back) all work
- [ ] Quit via tray → **Quit Mult Console** fully exits

---

## 6. Trial & licensing (force the UI on in dev)

Licensing is normally off in dev. Force it with env vars:

**Trial state:**
```bash
MULT_FORCE_TRIAL=1 npm start
```
- [ ] Header shows a **`Trial · 14d`** chip (amber)
- [ ] Open **License** → status reads *"Trial — 14 days left"*, with a key box

**Expired state:**
```bash
MULT_FORCE_TRIAL=1 MULT_TRIAL_DAYS=0 npm start
```
- [ ] An amber **"trial has ended"** banner appears at the top
- [ ] The License modal **auto-opens** on launch (dismissible)
- [ ] **Everything still works** — nothing is disabled (nag-only) ✅

**Activate a real key** (generate your own — don't commit it):
```bash
# one-time, if you haven't already:
node tools/gen-keypair.js
# issue a test key:
node tools/gen-license.js --name "Test User" --email test@example.com --tier studio
```
Copy the printed `MULT.…` key, then in the app (still under `MULT_FORCE_TRIAL=1`):
- [ ] **License → paste key → Activate** → *"✓ Activated"*, chip turns to
      **Licensed**, banner (if any) disappears
- [ ] Quit and relaunch with `MULT_FORCE_TRIAL=1 npm start` → still **Licensed**
      (the key is re-verified on launch)
- [ ] Paste a **garbage** key → rejected with a clear error
- [ ] **Deactivate** → returns to Trial

---

## 7. What to report back

For anything that failed, note:

1. **Step #** and what you clicked/did
2. **Expected** vs **actual**
3. Anything in the **Activity** panel, or the terminal where `npm start` runs
   (errors print there)
4. OS + Ableton version + controller model

Paste that here and I'll fix it. Once steps 1–6 pass, the app is proven working
and we can cut a signed release.
