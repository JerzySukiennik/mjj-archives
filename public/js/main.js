// js/main.js — bootstrap + owner of the render loop (Phase 3: multiplayer).
//
// Boot flow:
//   1) load manifest + PlaybackClock + renderer + scene + Performer (as Phase 1)
//   2) build WalkControls / DirectorCamera / Avatars
//   3) show the lobby entry; on create/join -> Room + ClockSync + Presence
//   4) collapse lobby to a chip, walk the hall (pre-show), sync avatars/presence
//   5) host runs the full HostPanel deck + Keybinds; guests get a minimal GuestBar
//   6) on Start (state 'performing' + cameraForced) all cameras lock to the
//      DirectorCamera; otherwise everyone free-walks.
//
// The NON-NEGOTIABLE contract is preserved verbatim:
//   const t = clock.currentTime; performer.update(t);   // every frame, pure fn of audio
//   PlaybackClock stays the SOLE owner of the <audio> element.
// Firestore work is NEVER awaited inside the render loop.

import * as THREE from 'three';

import { loadConcert } from './ConcertLoader.js';
import { PlaybackClock } from './PlaybackClock.js';
import { LobbyUI } from './LobbyUI.js';
import { HostPanel } from './ui/HostPanel.js';
import { GuestBar } from './ui/GuestBar.js';
import { Keybinds } from './ui/Keybinds.js';
import { CompareMode } from './CompareMode.js';

const MANIFEST_URL = './concerts/motown25-billiejean/concert.json';

// Seats-area AABB the WalkControls clamp to (matches Task S spec).
const WALK_BOUNDS = { minX: -9, maxX: 9, minZ: 4, maxZ: 16, eyeY: 1.7 };
const SPAWN = { x: 0, y: WALK_BOUNDS.eyeY, z: 12 };

// DOM refs.
const overlay = document.getElementById('loading-overlay');
const overlayInner = overlay.querySelector('.overlay-inner');
const statusEl = document.getElementById('loading-status');
const barEl = document.getElementById('loading-bar');
const hintEl = document.getElementById('loading-hint');
const canvasContainer = document.getElementById('canvas-container');
const lobbyEl = document.getElementById('lobby-overlay');
const walkHintEl = document.getElementById('walk-hint');

function setStatus(msg) { statusEl.textContent = msg; }
function setProgress(frac) { barEl.style.width = Math.round(Math.min(Math.max(frac, 0), 1) * 100) + '%'; }
function showError(title, detail) {
  overlayInner.classList.add('error');
  overlay.querySelector('.overlay-title').textContent = title;
  statusEl.textContent = detail;
  barEl.style.width = '0%';
  console.error(`[main] ${title}: ${detail}`);
}

async function boot() {
  // 1) Manifest.
  setStatus('Loading manifest…');
  let manifest;
  try {
    manifest = await loadConcert(MANIFEST_URL);
  } catch (err) {
    showError('MANIFEST ERROR', err.message);
    return;
  }
  document.title = `MJJ Archives — ${manifest.name}`;
  setProgress(0.15);

  // 2) Clock (sole owner of <audio>).
  setStatus('Preparing audio…');
  const clock = new PlaybackClock(manifest.audio, { duration: manifest.duration });
  setProgress(0.3);

  // 3) Renderer.
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Intel MBP clamp.
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  canvasContainer.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05040a);

  // 4) Scene build (Task B modules). Fail loudly but keep shell testable.
  setStatus('Building the hall…');
  let hall = null;
  let lighting = null;
  let performer = null;
  let stageAnchor = new THREE.Object3D(); // fallback anchor if Hall isn't present yet.
  scene.add(stageAnchor);

  try {
    const { createHall } = await import('./scene/Hall.js');
    const built = createHall(scene, {});
    hall = built;
    if (built && built.stageAnchor) stageAnchor = built.stageAnchor;

    const { createLighting } = await import('./scene/Lighting.js');
    lighting = createLighting(scene, stageAnchor, {});

    setStatus('Loading performer…');
    const { Performer } = await import('./scene/Performer.js');
    performer = await Performer.load(manifest, {
      onProgress: (frac) => setProgress(0.5 + frac * 0.4),
    });
    if (performer && performer.object3d) {
      const stageWorldAnchor = stageAnchor.getWorldPosition(new THREE.Vector3());
      // setAnchor composes the stored drop-to-floor offset on top of the stage
      // anchor (fixes the Phase-1 clobber where position.copy() flattened it).
      if (typeof performer.setAnchor === 'function') performer.setAnchor(stageWorldAnchor);
      else performer.object3d.position.copy(stageWorldAnchor);
      scene.add(performer.object3d);
    }
  } catch (err) {
    console.warn('[main] scene modules unavailable, running shell-only:', err.message);
    setStatus('Scene modules pending — running shell only.');
    if (!lighting) {
      const amb = new THREE.AmbientLight(0x404050, 1.2);
      const spot = new THREE.SpotLight(0xffffff, 60, 0, Math.PI / 6, 0.4, 1.2);
      spot.position.set(0, 8, 6);
      spot.castShadow = true;
      scene.add(amb, spot);
    }
  }
  setProgress(0.9);

  // 5) Camera + first-person controls + director cam + avatars (Task S modules).
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(SPAWN.x, SPAWN.y, SPAWN.z);
  const stageWorld = stageAnchor.getWorldPosition(new THREE.Vector3());
  camera.lookAt(stageWorld.x, stageWorld.y + 1.4, stageWorld.z);

  let walkControls = null;
  let directorCamera = null;
  let avatars = null;
  try {
    const { WalkControls } = await import('./WalkControls.js');
    walkControls = new WalkControls(camera, renderer.domElement, { bounds: WALK_BOUNDS });
  } catch (err) {
    console.warn('[main] WalkControls unavailable:', err.message);
  }
  try {
    const { DirectorCamera } = await import('./DirectorCamera.js');
    directorCamera = new DirectorCamera(camera, stageAnchor);
    directorCamera.setEnabled(false);
    // Feed the director cam the performer's live focus points (feet/chest/face).
    if (performer && typeof directorCamera.setFocusProvider === 'function') {
      directorCamera.setFocusProvider((k, out) => performer.getFocusPoint(k, out));
    }
    // Load the TV-cut camera track (fire-and-forget; loads during boot, well
    // before Start). No-op if the manifest field is null or the method is absent.
    if (typeof directorCamera.loadTrack === 'function') {
      directorCamera.loadTrack(manifest.cameraTrack)
        .catch((e) => console.warn('[main] camera track load failed:', e && e.message));
    }
  } catch (err) {
    console.warn('[main] DirectorCamera unavailable:', err.message);
  }
  try {
    const { Avatars } = await import('./scene/Avatars.js');
    avatars = new Avatars(scene);
  } catch (err) {
    console.warn('[main] Avatars unavailable:', err.message);
  }

  setProgress(1);

  // ---- shared runtime state (mutated once a room is joined) ----
  const rt = {
    room: null, presence: null, clockSync: null,
    hostPanel: null, guestBar: null, keybinds: null, compare: null,
    avatars, directorCamera, walkControls,
    inHall: false, wasPerforming: false, latestRoomDoc: null,
  };

  // Snap the local camera + walk pose back to SPAWN (host reset / guest event).
  function snapToSpawn() {
    camera.position.set(SPAWN.x, SPAWN.y, SPAWN.z);
    const stageW = stageAnchor.getWorldPosition(new THREE.Vector3());
    camera.lookAt(stageW.x, stageW.y + 1.4, stageW.z);
    if (walkControls) {
      // WalkControls owns its own integrated position (no public reset). Nudge
      // its internal pose to SPAWN so update() doesn't snap the camera back.
      if (walkControls._pos && walkControls._pos.set) {
        walkControls._pos.set(SPAWN.x, SPAWN.y, SPAWN.z);
      }
    }
  }
  window.__mjj = { clock, renderer, scene, camera, performer, hall, lighting, ...rt };
  const syncGlobals = () => Object.assign(window.__mjj, rt);

  // 6) Lobby. Assets are loaded by now; reveal the lobby instead of the transport.
  const lobby = new LobbyUI(lobbyEl);
  overlay.classList.add('hidden');

  // Dynamically load the net layer. If Firestore is unreachable, the scene still
  // renders behind the lobby and we surface an error rather than bricking.
  let net = null;
  try {
    const [FirebaseClient, RoomMod, ClockSyncMod, PresenceMod] = await Promise.all([
      import('./net/FirebaseClient.js'),
      import('./net/Room.js'),
      import('./net/ClockSync.js'),
      import('./net/Presence.js'),
    ]);
    net = {
      db: FirebaseClient.db,
      Room: RoomMod.Room,
      ClockSync: ClockSyncMod.ClockSync,
      Presence: PresenceMod.Presence,
    };
  } catch (err) {
    console.warn('[main] net layer unavailable:', err.message);
  }

  lobby.showEntry({
    onCreate: (name) => enterRoom('create', { name }),
    onJoin: (code, name) => enterRoom('join', { code, name }),
  });

  async function enterRoom(mode, { name, code }) {
    if (!net) {
      lobby.setError('Multiplayer is unavailable (cannot reach Firestore).');
      return;
    }
    lobby.setError('');
    lobby.setStatus(mode === 'create' ? 'Creating room…' : 'Joining room…');
    let room;
    try {
      room = mode === 'create'
        ? await net.Room.create({ db: net.db, name })
        : await net.Room.join({ db: net.db, code, name });
    } catch (err) {
      console.error('[main] room error:', err);
      // Back to the entry view with the failure surfaced.
      lobby.showEntry({
        onCreate: (n) => enterRoom('create', { name: n }),
        onJoin: (c, n) => enterRoom('join', { code: c, name: n }),
      });
      lobby.setError(mode === 'join'
        ? 'Could not join: room full, not found, or already started.'
        : 'Could not create the room. Try again.');
      return;
    }

    rt.room = room;
    const isHost = room.isHost;
    const clockSync = new net.ClockSync(net.db, room.code, room.playerId);
    const presence = new net.Presence(net.db, room.code, room.playerId);
    rt.clockSync = clockSync;
    rt.presence = presence;
    if (avatars) avatars.setLocalId(room.playerId);
    // Register presence with the room so Room.leave() can tidy the heartbeat.
    if (room.attachPresence) room.attachPresence(presence);
    syncGlobals();

    // Room lobby view.
    lobby.showRoom({
      room, isHost,
      onStart: () => { if (room.startPerformance) room.startPerformance(); },
      onLeave: () => { try { room.leave(); } catch (e) {} window.location.reload(); },
    });

    // Presence — player list drives the lobby list, the avatars, and (host) the
    // in-performance players drawer.
    presence.onPlayers((players) => {
      lobby.updatePlayers(players);
      if (avatars) avatars.sync(players);
      if (rt.hostPanel) rt.hostPanel.updatePlayers(players);
      if (isHost) {
        const all = players.length > 0 && players.every((p) => p.ready);
        lobby.setStartEnabled(all);
        lobby.setStatus(all ? 'All players ready.' : 'Waiting for players to load…');
      }
    });
    presence.startHeartbeat();

    // Host authority: heartbeat + stale-guest janitor.
    let janitor = null;
    if (isHost) {
      if (room.startHostHeartbeat) room.startHostHeartbeat();
      janitor = setInterval(() => { try { presence.removeStale(); } catch (e) {} }, 5000);
    }

    // Session end (host left / heartbeat stale). Support both the event and the cb API.
    const onEnded = () => {
      if (janitor) clearInterval(janitor);
      showSessionEnded();
    };
    if (room.on) room.on('sessionended', onEnded);
    if (room.onSessionEnded) room.onSessionEnded(onEnded);

    // Cache the latest room doc so the render loop can read transport.cameraForced.
    if (room.on) room.on('roomchange', (doc) => { rt.latestRoomDoc = doc; });

    // Clock sync engine: bind transport replication (host) / application (guest).
    room.attachClock(clock, clockSync);

    // ---- Phase 4 transport UI: host deck OR guest bar ----
    if (isHost) {
      // Pending A-B loop endpoints held locally until both are valid.
      let pendingA = 0;
      let pendingB = null;

      const cbs = {
        onLighting: (p) => {
          if (lighting && lighting.applyPreset) lighting.applyPreset(p);
          if (room.setLightingPreset) room.setLightingPreset(p);
          if (rt.hostPanel) rt.hostPanel.setLightingUI(p);
        },
        onSetLoopA: (t) => {
          pendingA = t;
          if (pendingB != null && pendingB > pendingA) {
            if (room.setAbLoop) room.setAbLoop(pendingA, pendingB);
            rt.hostPanel.setLoopUI(pendingA, pendingB);
          } else {
            rt.hostPanel.setLoopUI(pendingA, pendingB); // show A flag, B stays if any
          }
        },
        onSetLoopB: (t) => {
          pendingB = t;
          if (pendingB > pendingA) {
            if (room.setAbLoop) room.setAbLoop(pendingA, pendingB);
            rt.hostPanel.setLoopUI(pendingA, pendingB);
          }
        },
        onClearLoop: () => {
          pendingA = 0; pendingB = null;
          if (room.clearAbLoop) room.clearAbLoop();
          rt.hostPanel.setLoopUI(null, null);
        },
        onResetSeats: () => {
          if (room.resetPlayersToSeats) room.resetPlayersToSeats();
          snapToSpawn();
        },
        onKick: (id) => { if (room.kickPlayer) room.kickPlayer(id); },
        onCompareToggle: () => {
          if (!rt.compare) rt.compare = new CompareMode(clock, manifest);
          const on = rt.compare.toggle();
          if (rt.hostPanel) rt.hostPanel.setCompareActive(on);
        },
        onStop: () => { if (room.stopPerformance) room.stopPerformance(); },
        onRestart: () => { clock.seek(0); if (!clock.playing) clock.play(); },
      };

      const panel = new HostPanel(clock, cbs, {
        markersUrl: manifest.markers,
        duration: manifest.duration,
      });
      rt.hostPanel = panel;
      panel.setLightingUI('single-spot');
      rt.keybinds = new Keybinds(clock, panel, cbs);
    } else {
      rt.guestBar = new GuestBar(clock);
      if (room.on) {
        room.on('lightingchange', (p) => { if (lighting && lighting.applyPreset) lighting.applyPreset(p); });
        room.on('resetseats', () => snapToSpawn());
        room.on('kicked', () => {
          overlayInner.classList.add('error');
          overlay.querySelector('.overlay-title').textContent = 'REMOVED FROM SESSION';
          statusEl.textContent = 'You were removed from the session.';
          overlay.classList.remove('hidden');
          try { room.leave(); } catch (e) {}
          setTimeout(() => window.location.reload(), 2600);
        });
      }
    }

    // NTP-style clock calibration, then report ready once assets + sync are done.
    lobby.setStatus('Syncing clock…');
    try {
      await clockSync.calibrate();
      if (clockSync.startAutoRecalibrate) clockSync.startAutoRecalibrate();
    } catch (err) {
      console.warn('[main] clock calibration failed (continuing):', err.message);
    }
    presence.setReady(true);

    // Enter the hall: collapse lobby to a chip and start walking.
    enterHall();
    syncGlobals();
  }

  function enterHall() {
    rt.inHall = true;
    lobby.collapseToChip();
    camera.position.set(SPAWN.x, SPAWN.y, SPAWN.z);
    if (walkControls) {
      // Pointer lock requires a user gesture — arm it on canvas click.
      walkHintEl.classList.remove('hidden');
      const armLock = () => { try { walkControls.enable(); } catch (e) {} };
      renderer.domElement.addEventListener('click', () => {
        if (!isPerforming()) armLock();
      });
    }
  }

  function isPerforming() {
    const room = rt.room;
    if (!room || room.state !== 'performing') return false;
    const tr = (room.transport) || (rt.latestRoomDoc && rt.latestRoomDoc.transport);
    if (tr && typeof tr.cameraForced === 'boolean') return tr.cameraForced;
    return true; // performing implies director-cam lock by contract.
  }

  function showSessionEnded() {
    overlayInner.classList.add('error');
    overlay.querySelector('.overlay-title').textContent = 'SESSION ENDED';
    statusEl.textContent = 'The host ended the session. Returning to the lobby…';
    overlay.classList.remove('hidden');
    setTimeout(() => window.location.reload(), 2600);
  }

  // First-gesture autoplay hint (host only ever triggers play).
  clock.on('autoplayblocked', () => { hintEl.textContent = 'Press PLAY to start'; });

  // 7) Resize.
  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  }
  window.addEventListener('resize', onResize);

  // Best-effort leave on tab close.
  window.addEventListener('pagehide', () => { if (rt.room) { try { rt.room.leave(); } catch (e) {} } });

  // 8) RENDER LOOP — audio-slaved. NEVER deltaTime into the performer.
  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    // Sync backbone: animation is a pure function of the audio playhead.
    const t = clock.currentTime;
    if (performer) performer.update(t);

    if (rt.inHall) {
      const performing = isPerforming();
      if (performing && !rt.wasPerforming) {
        // Lock everyone to the director cam.
        if (walkControls) walkControls.disable();
        walkHintEl.classList.add('hidden');
        if (directorCamera) directorCamera.setEnabled(true);
        rt.wasPerforming = true;
      } else if (!performing && rt.wasPerforming) {
        // Back to free-walk between runs.
        if (directorCamera) directorCamera.setEnabled(false);
        walkHintEl.classList.remove('hidden');
        rt.wasPerforming = false;
      }

      if (performing) {
        if (directorCamera) directorCamera.update(t);
      } else if (walkControls) {
        walkControls.update(dt);
        // Fire-and-forget presence write (self-throttled to ~5Hz; never awaited).
        if (rt.presence) {
          const pose = walkControls.getPose();
          rt.presence.updatePose(pose.pos, pose.yaw);
        }
      }
    }

    if (avatars) avatars.update(dt);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot();
