# YOUWEE Decision Log & Build/Test Record

Chronological record of design decisions and of the build/test process.
Updated by the 2-hour documentation loop; each pass appends dated entries rather
than rewriting history.

## Decisions

### D1 — Browser, not terminal (2026-11-03)
The brief says "terminal" game, but the defining input — the built-in camera —
is only accessible via `getUserMedia`, i.e. a browser. Decision: implement as a
single web page with a terminal-cabinet aesthetic (phosphor palette, scanlines,
monospace) instead of a literal terminal app. Rationale: honor the spirit
(camera control + Atari feel) over the letter (terminal). Open alternative: a
true terminal port would need OpenCV-class capture plus ASCII rendering —
rejected as higher cost for worse camera UX.

### D2 — Vanilla JS, zero dependencies (2026-11-03)
Whole game in one ~720-line IIFE. No framework, no bundler, no npm. Rationale:
Atari-scope game doesn't need a toolchain; zero-dep means the game runs by
opening/serving three files, and the docs loop can verify it trivially.

### D3 — 192×128 logical framebuffer, fixed palette (2026-11-03)
Chunky pixels + amber/green/red/white on black, CSS-upscaled with
`image-rendering: pixelated`. Rationale: authentic Atari-era constraint; also
keeps the render code to fillRect/text primitives with no assets to ship.

### D4 — Camera = centroid-X + energy spike (2026-11-03)
48×36 luminance frame-differencing; centroid X steers, normalized-energy spike
fires. Threshold 24, trigger 0.16, 700 ms cooldown. Rationale: runs per-frame in
JS with no libraries or ML models; robust enough for lean-to-move / jab-to-act.
Known limitation: sensitive to lighting changes and background motion — accepted
for v1, mitigated by smoothing and the active-pixel floor (>12 to steer).

### D5 — Unified input path: camera and keyboard call the same functions (2026-11-03)
`fireAction()` / `cursor` are shared; there is no camera-only gameplay branch.
Rationale: the brief demands "no fake" — a single code path guarantees the
camera genuinely plays the same game as the keyboard, and keyboard fallback is
automatic rather than a second implementation.

### D6 — Score submission is best-effort; server not yet built (2026-11-03)
Client POSTs to same-origin `/api/score` (the code comment references a planned
`server.py`), shows OK/offline status, and plays identically either way.
Rationale: ship the playable game first; persistence is additive. Gap tracked:
`server.py` does not exist in the repo yet.

### D7 — Fail-soft everywhere (2026-11-03)
Loop try/catch parks on menu with the error shown; audio/camera/server each
degrade to a message. Rationale: a "cabinet" game should never show a blank
screen or a console-only error.

### D8 — `agentAssignment.md` is out of scope (2026-11-03)
That file describes Aether model-routing (`muse-spark` vs `muse-wonder`) and has
no connection to the baseball game. Kept in repo as-is for now (not deleted
without owner say-so) but excluded from the game's design; flagged for
move-or-delete by the owner.

## Build process

- **Build system:** none — static files, no compile/bundle step (per D2).
- **Run:** `cd client && python3 -m http.server 8000`, open `http://localhost:8000`.
  Plain `file://` works for keyboard play but camera needs `http://localhost`
  (secure context) and will show the unsupported/denied message otherwise.
- **Verification performed (2026-11-03 pass):** static read-through of all three
  client files; confirmed unified input path, state machine, and fail-soft error
  handling by inspection. No runtime browser test harness exists yet.

## Test process

- **Automated tests:** none yet. Recommended next step: extract pure logic
  (contact quality, count/out transitions, CPU-batter probabilities) into
  testable functions with a small Node-based assertion script, keeping the IIFE
  browser-safe.
- **Manual test script (current):**
  1. Open page → menu shows, role defaults to batter.
  2. Press 1/2 → role label and menu cursor change.
  3. ENTER → play; arrows move batter/aim; Space swings/throws.
  4. M → camera prompt; wave to move, jab to act; meter responds.
  5. Play to 3 outs (batter) / 3 conceded (pitcher) → game-over screen, offline
     score note, ENTER restarts.
- **Last manual run:** not yet executed in this loop environment (no browser
  harness attached). First runtime smoke test is the top testing priority.

## 2026-11-03 — Initial documentation & repo creation
First loop pass: wrote README.md, docs/DESIGN.md, and this log from a full
code read; initialized git; created the GitHub repo and pushed. Gaps logged for
future passes: missing `server.py`, no automated tests, no runtime smoke test,
`agentAssignment.md` placement undecided.
