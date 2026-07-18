# MASTER PROMPT — "MJJ Archives" (multiplayer 3D concert-recreation viewer)

> Paste this whole file to a fresh Claude Code session opened in
> `/Users/jurek/Downloads/Claude/Projects/MJJ Archives`. It is a complete,
> self-contained build spec. Read it fully before writing any code.

---

## 0. Mission

Build **MJJ Archives** — a small multiplayer web app where friends join a room, spawn as
avatars inside a recreated concert hall, and the **host** runs a transport panel. On **Start**,
a realistic **3D Michael Jackson** model performs the concert's choreography **synchronized to
the real audio**, while everyone's camera locks to a cinematic **director cam that reproduces the
original TV broadcast's camera cuts 1:1**.

First and (for now) only concert: **Billie Jean — Motown 25: Yesterday, Today, Forever (1983)**.

This is Jurek's project. He is a vibecoder — he does **not** touch code, terminal, or git.
**You do everything**: fetch assets from the internet without asking, run the offline pipeline,
build the app, deploy it. Conversation in Polish is fine, but **all code, comments, commits, and
in-game UI are in English**.

## 0.1 Execution policy (read §11 before you build)

**Build this as a multi-agent team, not one linear agent.** Model assignment is mandatory and
non-negotiable:
- **Planner / architect agent → Fable 5, Medium reasoning effort** (`claude-fable-5`, effort `medium`).
- **Every other agent** (executors, reviewers, verifiers, asset-sourcers, deploy) **→ Opus 4.8**
  (`claude-opus-4-8`).

Full role breakdown and the exact way to pin these models/efforts is in **§11**.

---

## 1. THE THREE NON-NEGOTIABLE PRIORITIES (in order)

These were explicitly ranked most important by Jurek. Everything else is secondary.

1. **Tight sync of MJ's movement to the music.** The animation must be *slaved to the audio
   playhead*, not to frame-time. If a client's framerate dips, the dance still lands on the beat.
2. **A good model and good movement** that faithfully recreate **this specific performance**.
3. **Great, realistic textures** (PBR materials) on the model and the hall.

When you must trade something off, protect these three in this order.

---

## 2. Assets (already on disk — verified)

Discover robustly with globs (folder names contain spaces/parens; don't hardcode brittle paths):

- **Reference video** (source for BOTH motion capture AND the TV camera cuts):
  `Assets/Koncerty/1/Video*/*.mp4`
  → `Michael Jackson - Billie Jean (Motown 25 Performance) (Remastered).mp4`
  1280×720, **59.94 fps**, **296.79 s (4:57)**, h264, ~85 MB.
- **Audio** (the sync target, ships with the game):
  `Assets/Koncerty/1/Audio*/*.mp4`
  → `videoplayback.mp4`, AAC ~129 kbps, **296.77 s (4:57)**, ~4.8 MB.

**Critical fact:** video and audio are the same length (296.8 s) and **time-aligned** — video
frame at time *t* corresponds to audio at time *t*. This alignment is the backbone of the whole
pipeline. Verify it early (spot-check a couple of obvious beats) and re-sync if off.

`ffmpeg`/`ffprobe` are installed at `/usr/local/bin`.

---

## 3. Tech stack & hard constraints

- **Rendering:** three.js, ES modules from CDN, **no build step** (matches Jurek's proven pattern).
  No physics engine needed — this is synchronized playback, not simulation.
- **Model + animation format:** glTF/GLB. Drive it with `THREE.AnimationMixer`, but **advance the
  mixer from the audio's `currentTime`, never from `deltaTime`** (see §5.2). This is what makes A/V
  sync frame-rate-independent and perfect on every client locally.
- **Audio:** a local `<audio>` element per client (the file is bundled). Its `currentTime` is the
  local master clock.
- **Multiplayer:** **Firebase Firestore** (account `gzowotesla@gmail.com` — Jurek's universal
  account). Room code join, **up to 4 players**, internet. Only transport state + a synced clock
  cross the network; **audio never streams** — each client plays its own local copy.
- **Hosting:** **GitHub Pages** (static game, GitHub user `JerzySukiennik`) + Firestore for sync.
- **Performance target = the real machine:** MacBook Pro 16" **2019, Intel i9, AMD Radeon Pro
  5500M 4 GB, 16 GB**. This is the benchmark, not an M-chip. Ship **Low/Med/High quality presets +
  auto-detect**, target **60 fps on Medium** on this hardware. Per-player quality slider.
- **Language:** game UI in English; UI visual style is **retro '83 / "archive"** (analog, vinyl,
  film grain, amber CRT/diode accents) but still clean. The 3D hall itself is realistic, not retro.

---

## 4. Offline preprocessing pipeline (you run this ONCE; it produces committed assets)

The shipped game is 100% static. The heavy ML lives only in dev-time preprocessing. Put scripts in
`pipeline/`, outputs in `public/concerts/motown25-billiejean/`.

**Be honest with yourself about difficulty:** monocular 3D pose recovery of MJ's fast, stylized
footwork, from a 720p TV recording with camera cuts, crowd, and motion blur, is bleeding-edge and
will be imperfect. Plan for iteration. Priority order for motion quality (Jurek chose
**fidelity over smoothness** — see §9):

### 4.1 Motion capture → animation clip
1. Extract frames from the video (keep the 59.94 fps timing, or resample to 60).
2. Run a monocular **3D human mesh/pose recovery** model. Preferred: **4D-Humans / HMR2.0** or
   **WHAM** (SMPL output, handles video). Fallback: **MediaPipe Pose** (faster, 2D→3D lift, lower
   fidelity). Fetch and set these up yourself.
3. **Retarget** the recovered skeleton/SMPL motion onto the chosen rigged model (§6.3). Bake to a
   **glTF animation clip time-aligned to the audio** (t=0 of the clip = t=0 of the audio).
4. **Cleanup — fidelity-first:** apply only *light* de-jitter/smoothing; do **not** over-stylize
   or "clean up" the character out of the motion. Where mocap is genuinely unusable (hard cut, full
   occlusion), hand-key those spans to match the **real move as closely as possible** (not a
   generic stylized filler). Cover the **entire 4:57**, including the spoken intro — Jurek wants
   every second animated to a maximal standard.
5. Tag **iconic-moment timestamps** as named jump markers: intro pose (hat down), first Billie Jean
   beat, spins, toe-stand, the **moonwalk**, kicks, finale. Emit `markers.json`.

Output: `mj.glb` (rigged model), `billiejean.motion` (glTF clip or compact keyframe JSON),
`markers.json`.

### 4.2 Director camera track (reproduce the TV cuts 1:1)
1. Detect scene/shot boundaries in the video (`ffmpeg` scene filter or **PySceneDetect**) → an
   ordered **cut list with exact timestamps**.
2. For each shot, classify framing (wide / medium / close-on-feet / close-on-face / stage-side) by
   inspecting representative frames.
3. Author a **camera track JSON**: at each cut timestamp, switch the in-engine director cam to a
   shot that mirrors the TV framing (e.g. close-on-feet during the moonwalk, close-on-face on the
   pose). This is what "host dictates camera, reproduces the broadcast" means at runtime.

Output: `camera-track.json`.

### 4.3 Concert manifest (keep it data-driven, but NO archive UI yet)
Emit `concert.json` describing this concert: display name, audio path, model path, motion path,
camera-track path, markers path, hall id, duration. The game reads this manifest so a **second
concert is drop-in later** (add `Koncerty/2` + a manifest entry) — but for now the game goes
**straight into this one concert; do not build an archive/shelf screen.**

**If the ML environment can't run** (no GPU, deps fail): don't stall. Produce the best result you
can from whatever runs (even MediaPipe + heavy hand-keying of the iconic moves on the beat), ship a
working vertical slice, and clearly note in the repo README what's mocap vs hand-authored so it can
be improved later. **Never ship broken/glitching motion as "done."**

---

## 5. Runtime architecture

### 5.1 Scene
- **Hall:** evoke the **Pasadena Civic Auditorium** (Motown 25 venue) — dark theater, art-deco
  proscenium, band risers upstage, dramatic lighting. **Not** a photogrammetric 1:1 reconstruction;
  recognizable and atmospheric with realistic PBR materials.
- **Lighting:** the signature look is a single dramatic **spotlight**. Support host lighting presets
  (single spot / full stage / blackout). Bake where possible for perf.
- **Audience:** **empty except player avatars.** No NPC crowd.
- **Player avatars:** simple **stylized silhouettes with a floating nametag**. Cheap, readable,
  don't steal focus from the stage.

### 5.2 Audio-slaved animation (the sync backbone — get this right first)
- Each frame: read `audio.currentTime`, set the `AnimationMixer` (and camera-track position) to
  that exact time. Animation is a **pure function of audio position**. Result: perfect local A/V
  sync at any framerate, and pause/seek/scrub/loop "just work" because they're all just moving the
  audio playhead.
- **Tempo (slow/fast):** use raw `audio.playbackRate` (Jurek chose **not** to preserve pitch — 0.5×
  = lower voice, 2× = chipmunk, that's intended/simplest). Because animation follows `currentTime`,
  the dance automatically tracks the rate change. Do **not** set `preservesPitch`.

### 5.3 Multiplayer (Firestore + clock sync)
- **Session model:** room **creator = host**, panel lives with the host, **no host migration** —
  host leaves ⇒ session ends. Join by **room code**. Max 4.
- **Room doc** holds: `hostId`, `players[]` (id, name, ready, avatar pos), and **transport state**:
  `{ playing, rate, muted, marker, lightingPreset, cameraForced }` plus a clock anchor
  `{ audioPositionAtAnchor, anchorServerTime }`.
- **Clock sync:** estimate each client's offset to a shared reference (NTP-style ping against a
  server timestamp / Firestore `serverTimestamp()`). On any transport change, host writes the anchor
  `(audioPosition, serverTime)`. Each client computes
  `expectedPos = audioPositionAtAnchor + (nowSynced − anchorServerTime) × rate`, seeks its local
  audio to `expectedPos` when it drifts beyond a tolerance (~120 ms), then lets it free-run and
  drift-corrects periodically. Target cross-client sync within a few hundred ms — inaudible for a
  watch-party, and each screen's own A/V is always perfect (§5.2).
- **Ready-check:** host cannot Start until all players report audio+model+motion loaded. Show a
  per-player ready list.
- **Host is authoritative** on all transport, camera, and lighting; clients render the resulting
  state.

### 5.4 Cameras
- **Before Start:** first-person, players walk around the hall as avatars and see each other.
- **On Start:** **all** players' cameras lock to the shared **director cam** driven by
  `camera-track.json`, which switches shots at the TV-cut timestamps. **Host dictates the camera for
  everyone** during the performance (Jurek's choice — like watching the broadcast together).
- Optional: host can drop everyone back to free look between runs.

### 5.5 Host control panel (UI **and** keyboard)
Core: **Start / Pause**, **Stop**, **tempo −/+** (raw rate, e.g. 0.25×–2×), **Mute / Unmute**.
Included by default: **Seek/scrub bar** (+/−10 s), **Restart**, **Ready-check**, **Reset players to
seats**. Chosen extras: **Jump-to-moment** markers (moonwalk, toe-stand, spin, …), **A–B loop**,
**lighting presets** (single spot / full / blackout), **Kick player**. (No movement-lock.)
Suggested keybinds: `Space` play/pause, `←/→` seek ±10 s, `R` restart, `[`/`]` A–B loop in/out,
`1..9` jump to markers, `M` mute, `-`/`=` tempo. Keep the panel styled like a **retro '83 mixing
console / archive deck**.

### 5.6 Compare mode (side-by-side)
A toggle that shows the **3D recreation next to the original video**, same playhead, for judging
sync fidelity. This doubles as your own QA tool. **Lazy-load the 85 MB reference video only when
compare mode is opened** (don't force it into the initial download). Host/solo toggle.

### 5.7 Quality presets
Low/Med/High + auto-detect on load (probe GPU/perf). Scale: shadow resolution, texture size,
post-processing (film grain/bloom), draw distance, avatar detail. Per-player slider in options.

---

## 6. Model MJ — sourcing (rig quality is the gate)

Jurek's directive: **best possible rig, best possible everything.**
1. Search for the **best free rigged MJ likeness model** (Sketchfab CC / community MMD-Blender-SFM
   assets). Evaluate its **rig** for mocap retargeting — humanoid bone hierarchy, clean weights.
2. **If the rig is too weak** to retarget cleanly, **fall back** to a top-quality rigged realistic
   human (Mixamo / ReadyPlayerMe-grade) and **dress it 1:1 in the Motown 25 costume**: black
   sequined jacket, single **white glove** (right hand), high-water black trousers, **white socks**,
   black loafers, black **fedora**. Silhouette + costume make it read unmistakably as MJ even if the
   face is generic.
3. Realistic PBR textures either way (priority #3).

Fetch everything yourself; respect that this is Jurek's personal, non-commercial project.

---

## 7. Build order (scope discipline — do NOT try to do it all at once)

> The **Planner (Fable 5 / medium)** turns each phase below into a concrete task list; **Opus 4.8**
> agents execute (in parallel where independent) and an **Opus 4.8 verifier** adversarially checks
> each phase before the next. See §11.

Ship a working **vertical slice** before going wide:
1. **Slice:** hall + model + audio-slaved animation for a **~20–30 s section** (pick the moonwalk)
   + basic transport (play/pause/seek) **single-player**. Prove sync is perfect locally.
2. Add the **full 4:57** motion + `camera-track.json` director cam + markers.
3. Add **Firestore multiplayer**: room code, up to 4, ready-check, host-authoritative transport +
   clock sync, avatars.
4. Add the **full host panel** (all controls + keybinds), lighting presets, compare mode.
5. **Polish:** retro '83 UI, quality presets, textures, deploy to GitHub Pages.

Verify each stage in the browser (use the preview/browser tools) before moving on.

---

## 8. Definition of done

- Host can create a room, share a code, 4 players join and appear as avatars.
- Ready-check gates Start; on Start every client's MJ dances **on the beat** and cameras lock to the
  broadcast-matching director cut.
- Transport (play/pause/stop/seek/restart/tempo/mute/A–B loop/jump-to-moment/lighting/kick) works
  from UI and keyboard, host-authoritative, synced to all clients.
- Compare mode shows 3D vs original in sync.
- Runs at ~60 fps on Medium on an Intel 2019 MBP.
- Deployed live on GitHub Pages; Firestore rules configured (see §10).

---

## 9. Honesty, pitfalls & the fidelity call

- **Auto-mocap of this footage is the hardest part and will be imperfect.** Camera cuts break
  continuous tracking; expect several iterations. Communicate progress honestly; don't claim a
  section is faithful when it isn't.
- **Fidelity over smoothness** (Jurek's explicit choice): keep raw mocap character even if it's
  slightly jittery, rather than smoothing MJ into a generic dancer. Only hand-key where mocap is
  truly unusable, and even then match the *real* move.
- **A "great" outcome** = a model that reads unmistakably as MJ, hitting the iconic moves locked to
  the audio, in an evocative Pasadena Civic hall — **not** a photoreal deepfake. Set expectations
  accordingly.
- **Never ship glitching/broken motion as finished.** If a span can't be made acceptable, hand-key
  the iconic pose on the beat and flag it in the README.
- Guard the Intel/AMD perf target; the empty audience helps — don't reintroduce a heavy crowd.

---

## 10. Deployment

- **Game:** GitHub Pages, user `JerzySukiennik`. Create a public repo (e.g. `mjj-archives`), enable
  Pages, deploy the static site.
- **Backend:** Firebase Firestore on `gzowotesla@gmail.com`. Create/use a project, add web app
  config, set Firestore security rules scoped to room docs (room-code gated; only host writes
  transport state; players write their own presence/ready). Keep rules tight but functional for a
  4-player watch-party.
- Bundle the audio (~4.8 MB) with the game; lazy-load the reference video for compare mode only.

---

## 11. Execution model — build this with a multi-agent team (REQUIRED)

Do **not** build MJJ Archives as a single linear agent. Orchestrate a **multi-agent workflow**.
Model assignment is mandatory:

- **Planner / architect → Fable 5, Medium reasoning effort** — `model: claude-fable-5`,
  `effort: medium`. Owns decomposition, sequencing, the data contracts between modules, and plan
  review. It **plans; it does not write production code.**
- **Every other agent → Opus 4.8** — `model: claude-opus-4-8`. Executors, reviewers, verifiers,
  asset-sourcers, deploy — all Opus 4.8.

### Roles (all Opus 4.8 except the Planner)
1. **Planner** *(Fable 5 / medium)* — turns each build phase (§7) into a concrete task list with
   explicit inputs/outputs and the contracts between modules: the concert manifest schema,
   `camera-track.json`, `markers.json`, the Firestore room-doc shape, and the **audio-slaved
   animation interface** (§5.2). Re-plans between phases.
2. **Pipeline/ML agent** *(Opus 4.8)* — offline mocap + retarget + scene-detect camera track (§4).
3. **Asset agent** *(Opus 4.8)* — source & evaluate the MJ model/rig, textures, hall refs (§6, §5.1).
4. **Rendering agent** *(Opus 4.8)* — three.js scene, hall, lighting, avatars, camera system,
   audio-slaved animation (§5.1/5.2/5.4).
5. **Netcode agent** *(Opus 4.8)* — Firestore rooms, clock sync, host authority, ready-check (§5.3).
6. **UI agent** *(Opus 4.8)* — host panel + keybinds, retro '83 styling, compare mode, quality
   presets (§5.5/5.6/5.7).
7. **Verifier agent** *(Opus 4.8)* — adversarial QA after each phase: sync correctness,
   host-authority, perf target, and that **no glitching motion ships**.
8. **Deploy agent** *(Opus 4.8)* — GH Pages + Firestore (§10).

### How to pin the models & efforts

**Preferred — the `Workflow` tool** (cleanly supports both model *and* reasoning effort per agent):
```js
// Planner — Fable 5, medium effort
const plan = await agent(plannerPrompt, {
  label: 'planner', phase: 'Plan',
  model: 'claude-fable-5', effort: 'medium', schema: PLAN_SCHEMA,
})
// Every executor / reviewer / verifier — Opus 4.8
await agent(taskPrompt, { label: 'rendering', model: 'claude-opus-4-8' })
```
In `meta.phases`, tag the planning phase with `model: 'claude-fable-5'` and the rest with
`model: 'claude-opus-4-8'`.

**Alternative — reusable subagent definitions** in `.claude/agents/*.md`: put the model and
reasoning effort in each agent's frontmatter (planner → `claude-fable-5` + medium effort; every
other agent → `claude-opus-4-8`).

**If you use the plain `Agent` tool:** pass `model: 'fable'` for the planner (the `fable` alias =
Fable 5) and `model: 'opus'` for everyone else (the `opus` alias = Opus 4.8). Note the plain Agent
tool cannot pin reasoning effort per call — so to guarantee the planner runs at **Medium**, drive it
via the Workflow tool's `effort: 'medium'` or a subagent definition, not a bare Agent call.

### Loop
Planner (Fable 5) plans a phase → Opus 4.8 executors build it in parallel where independent →
Opus 4.8 verifier adversarially checks it → Planner replans the next phase. Keep the §7
vertical-slice-first discipline: prove the audio-sync slice before fanning out the whole app.
