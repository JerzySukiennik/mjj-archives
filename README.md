# MJJ Archives

A multiplayer 3D viewer for reconstructed Michael Jackson concerts. You and up to
three friends drop into a shared virtual **Pasadena Civic Auditorium**, and a 3D
model of MJ performs — its dance driven by automatic motion-capture of the original
broadcast footage, locked frame-for-frame to the concert audio. One player hosts and
drives transport (play/pause, seek, loop, markers, lighting); everyone watches in sync.

**Concert 1:** *Billie Jean* — Motown 25 (1983), the debut of the moonwalk.

**Live:** https://jerzysukiennik.github.io/mjj-archives/

The UI is styled as a retro **1983 "archive retrieval system"** — amber CRT, film grain,
scanlines — while the 3D hall itself is rendered realistically.

---

## What's real, and what isn't (honest breakdown)

This is **not** a photoreal deepfake. It's a model that reads unmistakably as MJ, hitting
the iconic moves in an evocative hall, locked to the audio. The motion comes from a
**monocular (single-camera) MediaPipe-based mocap pipeline** run over the original TV
broadcast — which is genuinely hard, because camera cuts repeatedly break continuous
tracking.

**Coverage:** roughly **72.5% of the 296.77 s runtime is usable auto-mocap** — raw,
slightly jittery motion kept deliberately faithful rather than smoothed into a generic
dancer (fidelity over smoothness).

**The other ~27.5% is held/blended.** 26 spans totalling **~81.6 s** had tracking
confidence below 0.5 for longer than half a second (camera cut away, MJ turned from
camera, motion blur, crowd occlusion). Those spans are **slerp-blended between the
nearest good poses** so the model holds/eases through them instead of snapping or
glitching. The full list lives in
[`pipeline/work/unusable-spans.json`](pipeline/work/unusable-spans.json); the largest gaps:

| Span (s) | Length | Likely cause |
|---|---|---|
| 59.1 – 68.3 | ~9.2 s | audience/wide cuts |
| 78.5 – 85.0 | ~6.5 s | camera cut, off-axis |
| 136.0 – 148.7 | ~12.7 s | the long instrumental / crowd shots |
| 232.3 – 243.0 | ~10.7 s | wide + reaction cuts |
| 259.8 – 265.1 | ~5.2 s | off-axis turn |
| 276.1 – 280.9 | ~4.8 s | late-song cut |

### Known limitations

- **No twist axis.** Limb roll (forearm/upper-arm twist) isn't recovered from a single
  camera, so spins and wrist-rolls are approximate.
- **Approximate stage travel.** Root/world position is estimated; MJ's walk across the
  stage is plausible, not surveyed.
- **Monocular mocap.** Depth is inferred from one camera — sideways-facing poses and
  fast limbs are the weakest.
- **Camera cuts break tracking.** Every TV cut restarts continuity; the held/blended
  spans above are exactly where the broadcast cut away from a clean front view.

---

## Tech stack

- **three.js 0.160**, ES modules straight from a CDN import map — **no build step**.
- **Audio-slaved animation:** the `AnimationMixer` is advanced from the `<audio>`
  element's `currentTime`, never from frame delta — so A/V sync is frame-rate independent
  and perfect on every client locally. Audio never streams over the network; each client
  plays its own bundled copy.
- **Firestore multiplayer** (room code + synced clock; only transport state crosses the
  wire).
- **GitHub Pages** static hosting.

---

## Multiplayer

1. One player enters a nickname and clicks **CREATE ROOM** — they become the host.
2. Share the **6-character room code**.
3. Friends enter their nickname + the code and click **JOIN** (up to **4 players** total).
4. Everyone loads; each player shows **LOADING → READY** in the roster.
5. Once all are ready, the host clicks **START** and drives playback for the room.

Only the host writes transport state; each player writes their own presence/ready flag.

---

## Controls (host)

Transport is host-only, by button (host panel) or keyboard:

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` / `→` | Seek −10 s / +10 s |
| `R` | Restart from 0 |
| `[` / `]` | Set loop point A / B |
| `\` | Clear loop |
| `1`–`9` | Jump to marker N |
| `M` | Mute (local only) |
| `-` / `=` | Tempo down / up |
| `W A S D` + mouse | Walk around the hall (click to capture the pointer) |

Lighting presets (SPOT / FULL / BLACK), COMPARE (side-by-side with the original video),
PLAYERS roster, and per-player **quality** (AUTO / LOW / MED / HIGH) live in the host
panel; guests get the quality selector in their guest bar. Quality choice persists in
`localStorage`.

---

## Rerunning the mocap pipeline

The offline pipeline produces the committed assets in
`public/concerts/motown25-billiejean/`. You only need this to regenerate motion from the
source footage — the game runs entirely off the committed JSON/GLB.

```bash
cd pipeline
source venv/bin/activate          # Python 3.12

python extract_skeleton.py        # parse mj.glb bind pose      -> work/skeleton.json
python pose_extract.py            # MediaPipe pose over video   -> work/pose-raw.npz
python retarget.py                # retarget/clean/bake         -> ../public/.../billiejean.motion.json
                                  #                                work/unusable-spans.json
python markers.py                 # iconic-moment markers       -> ../public/.../markers.json
python validate.py                # stick-figure overlay frames -> work/validate/*.png
```

Camera cuts (the director-cam track) are derived under `pipeline/camera/`
(`detect-cuts.py` → `classify-shots.py` → `cuts.json`).

> Do **not** edit the pipeline scripts as part of a normal redeploy — they're the
> reproducible source of the committed assets.

---

## Deploy note (important)

ES modules are cached aggressively. On **every redeploy** bump the version constant in
`public/index.html`:

- `window.MJJ_V = 'N'` (top of `<head>`), **and**
- the matching `?v=N` on the `main.js` module `<script src>`.

Both must match. Dynamic imports inherit this version, so they bust immediately.
Statically-imported nested modules keep unversioned URLs, but GitHub Pages serves them
with a 10-minute `max-age`, so they settle within ~10 minutes of a redeploy.
