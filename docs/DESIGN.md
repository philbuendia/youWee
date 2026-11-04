# YOUWEE Design Document

Architecture, game systems, and implementation notes for the `client/` single-page game.
Source of truth is [`client/game.js`](../client/game.js) (~720 lines, vanilla JS, no dependencies).

## 1. Architecture

Single self-contained page. No framework, no bundler, no build step.

```text
index.html  → cabinet shell: 192×128 canvas, role/camera buttons, motion meter,
              hidden <video> + 48×36 buffer canvas for motion detection
style.css   → terminal-cabinet theme (amber/green phosphor), scanline overlay
game.js     → IIFE: state machine, physics, camera pipeline, renderer, audio
```

Runtime flow is one `requestAnimationFrame` loop: `update()` then `render()`,
both inside try/catch so a frame error parks the game on the menu with the
message visible instead of hard-crashing.

## 2. Core constants

| Constant | Value | Meaning |
|---|---|---|
| `W × H` | 192 × 128 | logical framebuffer |
| `GROUND_Y` | 104 | ground line; plate at (96, 96), mound at (96, 40) |
| `PITCH_FRAMES` | 90 | ball travel time, mound → plate |
| `HIT_WINDOW` | 14 | frames around arrival that count as hittable |
| `MOTION_TRIGGER` | 0.16 | normalized motion energy that fires an action |
| `TRIGGER_COOLDOWN_MS` | 700 | min gap between motion-triggered actions |
| Camera buffer | 48 × 36 | motion-detection resolution |
| Pixel threshold | 24 | per-pixel luminance delta to count as motion |

## 3. State machine

Three states: `MENU → PLAY → OVER`. Either role selectable via buttons or `1`/`2`;
selecting mid-game restarts. `ENTER`/Space/jab starts or restarts from menu/over.

Game state: runs (batter score), strikeouts (pitcher score), conceded runs,
balls/strikes/outs, inning, transient message + TTL, score-sent flag.

- At-bat end (`nextBatter`): count resets, 50-frame re-arm.
- Mid-at-bat (`nextPitch`): count persists, 50-frame re-arm.
- `registerOut`: 3rd out ends the game, else inning++ with a message.

## 4. Pitching & hitting

**Batter role (CPU pitches).** `cpuPitch()` targets in-zone 62% of the time.
`batterSwing()` (Space or camera jab) checks timing (`|t − 90| ≤ 14`) and
positioning (`|batterX − ballX| < 30`). Contact quality blends both into
single/double/triple/HR (runs += bases). A whiff kills the pitch (catcher holds it)
and records a strike. Taken pitches resolve at the plate: in-zone = called strike,
outside = ball; 4 balls = walk, scores a run.

**Pitcher role (CPU bats).** Aim maps `40 + cursor×112` (zone ≈ 76–116, so edges
are balls). `updateCpuBatter()` decides once mid-flight (55% of travel): chase
probability 75% in-zone / 28% outside; contact 55% / 22%. Contact concedes a run
(flying-ball animation); a swing-and-miss is a strike; takes resolve at the plate.
3 strikes = strikeout (score++, counts as an out); 4 balls = walk, concedes a run.
3 conceded = game over.

**Ball model.** Live ball interpolates mound → plate with quadratic easing
(accelerates toward the plate) and grows 1→3 px to fake depth. Hit balls switch
to ballistic flight (`hvy += 0.12`) until off-screen.

## 5. Camera pipeline (the controller)

1. `getUserMedia({video: 320×240})` → hidden `<video>`.
2. Each frame, draw to a 48×36 buffer and read luminance.
3. Frame-difference vs previous frame; pixels with Δ > 24 accumulate into an
   energy sum and an X-weighted centroid.
4. **Position:** centroid X (smoothed 65/35) → `cursor` 0..1. Requires > 12 active
   pixels to avoid drift on noise.
5. **Action:** normalized energy (`count / (48×36×0.45)`, smoothed 72/28) crossing
   0.16 with 700 ms cooldown → `fireAction()`.
6. Denied/unsupported camera → visible message + keyboard mode; retry via button.

`fireAction()` is shared: menu/over = start, batter = swing, pitcher = throw.
Camera and keyboard drive the identical code path — there is no separate
"camera logic" that could drift from real gameplay.

## 6. Rendering

Chunky-pixel Atari look on the 192×128 canvas, CSS-scaled with
`image-rendering: pixelated` plus a scanline overlay div:

- `drawField`: black sky, crowd dots, grass, mound/plate dirt, base lines, ground line.
- `drawActors`: pitcher + batter sprites (amber = human-controlled side),
  animated bat arc (`swingAnim` 18 frames), strike-zone box (flashes red on pitch),
  pitcher aim markers.
- `drawBall`: growing pixel square in flight; 4×4 square for batted balls.
- `drawHud`: `R/K/B/S/O` counts, inning, role, transient message, `CAM`/`KEYS` indicator.

## 7. Audio & score submission

- Square-wave `AudioContext` bleeps (hit arpeggio, strike/out/whiff/pitch motifs),
  created on first gesture per autoplay policy; every call guarded.
- Game over POSTs `{name, role, runs, ts}` to same-origin `/api/score`.
  Success shows `SERVER OK id=…`; failure shows an offline hint. No retry queue —
  the client is fully playable without a server.

## 8. Fail-soft philosophy

Every external dependency degrades to a message, never a crash: loop wrapped in
try/catch, audio cosmetic-only, camera optional, server optional. The game is
always playable with keyboard alone.
