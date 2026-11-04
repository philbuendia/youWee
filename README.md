# YOUWEE BASEBALL — Atari-Era Camera-Controlled Baseball

A simple Atari-era baseball game where **the built-in camera is the controller**.
Play as **pitcher** or **batter**: lean / wave side to side to move, quick jab to swing or throw.
Full keyboard fallback included. Zero dependencies — vanilla HTML/CSS/JS.

> Original brief (`description.md`): *"a simple terminal atari-era baseball game using the
> built-in camera; the player can either be a pitcher or a batter. the camera is the control."*

## Quick start

No build step. Serve the `client/` directory over HTTP (camera requires a secure context —
`localhost` counts) and open it:

```bash
cd client && python3 -m http.server 8000
# open http://localhost:8000
```

Click **ENABLE CAMERA** (or press `M`), allow camera access, pick a role, press ENTER.

| Input | Move | Swing / Throw | Start | Camera | Reset |
|---|---|---|---|---|---|
| Keyboard | ←/→ or A/D | Space | Enter | M | R |
| Camera | lean / wave side to side | quick jab toward camera | jab on menu | — | — |

## Project layout

```text
youWee/
├── README.md            # this file — what the project is, how to run it
├── description.md       # original one-line brief
├── agentAssignment.md   # unrelated agent-routing note (see DECISIONS §8)
├── client/
│   ├── index.html       # cabinet shell: canvas, buttons, hidden video elements
│   ├── style.css        # Atari terminal-cabinet styling, scanlines
│   └── game.js          # whole game: loop, physics, camera pipeline, audio (~720 lines)
└── docs/
    ├── DESIGN.md        # architecture, game systems, camera pipeline, rendering
    └── DECISIONS.md     # decision log + build/test process record
```

## How it plays

- **Batter role:** CPU pitches (62% strikes). Position with movement, swing with the
  action input. Timing + positioning decide single/double/triple/HR. 3 strikes = out,
  4 balls = walk (scores a run), 3 outs = game over. Score = runs.
- **Pitcher role:** aim across/around the zone, throw with the action input.
  CPU batter takes or swings probabilistically (chases 75% in-zone, 28% outside).
  Walks and hits allowed concede runs — 3 conceded = game over. Score = strikeouts.
- Final score POSTs to `POST /api/score` (same origin) when a backend is present;
  otherwise the game shows an offline note and keeps working. **No backend ships yet —
  see DECISIONS §6.**

## Tech notes

- Logical framebuffer **192×128**, 4-color palette, `requestAnimationFrame` loop.
- Camera pipeline: `getUserMedia` → 48×36 luminance frame-differencing → centroid-X
  steering + energy-spike actions (700 ms cooldown). Details in `docs/DESIGN.md`.
- Audio: square-wave WebAudio bleeps, created on first user gesture, cosmetic-only
  (all calls wrapped so audio can never break the game).

## Status

Playable single-page client. Known gaps (tracked in `docs/DECISIONS.md`):
server (`server.py` referenced by the client) not implemented, no automated tests,
no CI. This file and `docs/` are refreshed on a 2-hour documentation loop.
