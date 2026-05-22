# AudioLink — Church audio signal-chain configurator

Interactive signal-chain diagram and live-meter / calibration tool for a
church audio rig built around a **Proel MQ16FX** analog mixer.

## Live demo

Visit **https://lerryellis.github.io/AudioLink/** once GitHub Pages is enabled.

## What's in this repo

| File | Purpose |
|---|---|
| `index.html` | Tiny redirect landing page (so the bare Pages URL works) |
| `signal-chain.html` | The full diagram + control surface |
| `signal-chain.css` | All styles |
| `signal-chain.js` | All interactive logic |
| `mixer.webp` | Reference photo of the physical mixer |

## Run locally

A live microphone needs HTTPS or `http://localhost`, so serve over HTTP:

```bash
python3 -m http.server 8000
```

then open <http://localhost:8000/>.

## Features

- **Performance mode** — drag every knob, fader, MUTE, HI-Z / MIC-LINE switch.
- **Calibration mode** — connect your laptop mic, pick a channel (dropdown or
  click directly on the strip), hold the level inside the −18 to −12 dBFS
  target zone for 2 seconds → channel marked calibrated.
- **Routing mode** — click-to-wire cables (source jack → destination jack),
  add new devices to dedicated sections (Mics, Instruments, FOH & PA,
  Monitors, Stream/Record), select and delete any device (custom or
  default), undo every change.
- **Save / load** named configs to `localStorage`, plus JSON Export / Import
  so you can move configs between machines.
- **Default preset** — clears every cable on the diagram so you can rewire
  the whole rig manually.

## Modes at a glance

| Mode | Frame colour | What it does |
|---|---|---|
| Performance | grey | normal operation |
| Calibration | amber | live-meter feedback + per-channel ✓ |
| Routing | blue | jack hotspots, add/delete devices, cable management |

## Enabling GitHub Pages

After cloning / pushing:

1. Repo → **Settings → Pages**
2. **Source:** `Deploy from a branch`
3. **Branch:** `main` · folder `/ (root)`
4. **Save** — the site is live at the URL above within a minute.
