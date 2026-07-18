// DirectorCamera.js — shared cinematic camera for the performance.
//
// The camera is a PURE DETERMINISTIC FUNCTION of the audio time `t`. No
// deltaTime, no Date.now(), no wall clock, no per-frame mutable state that
// diverges between clients. Every client that calls update(t) with the same
// audio position renders the EXACT same framing — that is what "the host
// dictates the camera for everyone" requires. Seek / scrub / A-B loop all just
// work because the frame depends on nothing but `t`.
//
// PHASE 4: update(t) drives a TV-style cut list loaded from camera-track.json
// via loadTrack(url). It binary-searches the active shot (greatest cut time
// <= t), places the camera on a HARD CUT (no lerp between shots), aims at the
// performer via a focus provider, and adds deterministic handheld micro-sway.
// Until a track is loaded (or if loading fails) update(t) keeps the Phase-3
// fixed-vantage behaviour — graceful degradation, never a black screen.
//
// Frozen signatures (callers depend on these): constructor(camera, stageAnchor),
// setEnabled(on), update(t). New methods added this phase: loadTrack(url),
// setFocusProvider(fn).

import * as THREE from 'three';

export class DirectorCamera {
  /**
   * @param {THREE.PerspectiveCamera} camera - the shared scene camera.
   * @param {THREE.Object3D} stageAnchor - centre-stage anchor from Hall.js.
   */
  constructor(camera, stageAnchor) {
    this.camera = camera;
    this.stageAnchor = stageAnchor;
    this._enabled = false;

    // Track state (null until loadTrack succeeds).
    this._shotT = null;      // Float64Array of cut times, sorted ascending.
    this._shots = null;      // parallel array of shot objects.
    this._focusProvider = null; // fn(kind, outVec3) -> fills world-space point.

    // Reused temporaries — zero allocation in update().
    this._basePos = new THREE.Vector3(0, 2.4, 9.5);   // Phase-3 fixed vantage.
    this._pos = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._anchorWorld = new THREE.Vector3();
  }

  /** @param {boolean} on */
  setEnabled(on) {
    this._enabled = !!on;
  }

  /**
   * Supply a world-space focus resolver used to aim at the performer.
   * @param {(kind: 'feet'|'chest'|'face', out: THREE.Vector3) => void} fn
   */
  setFocusProvider(fn) {
    this._focusProvider = typeof fn === 'function' ? fn : null;
  }

  /**
   * Fetch + parse camera-track.json and build the shot lookup arrays. No-op if
   * `url` is falsy. On any failure the camera silently keeps the Phase-3
   * fixed-vantage behaviour (never throws, never black-screens).
   * @param {string|null} url
   */
  async loadTrack(url) {
    if (!url) return;
    let data;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (e) {
      console.warn('[DirectorCamera] track load failed, keeping fixed vantage:', e.message);
      return;
    }
    const shots = Array.isArray(data && data.shots) ? data.shots.slice() : [];
    if (shots.length === 0) {
      console.warn('[DirectorCamera] track has no shots, keeping fixed vantage.');
      return;
    }
    // Defensive: sort by t ascending so the binary search is valid.
    shots.sort((a, b) => (a.t || 0) - (b.t || 0));
    const shotT = new Float64Array(shots.length);
    for (let i = 0; i < shots.length; i++) shotT[i] = shots[i].t || 0;
    this._shots = shots;
    this._shotT = shotT;
    console.info(`[DirectorCamera] loaded ${shots.length} shots.`);
  }

  /**
   * Binary search: greatest index whose cut time <= t. Returns 0 when t is
   * before the first cut; returns the last index when t is past the last cut
   * (final shot holds through to the audio end). Pure function of t.
   * @param {number} t
   * @returns {number}
   */
  _findShot(t) {
    const arr = this._shotT;
    let lo = 0, hi = arr.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= t) { ans = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return ans;
  }

  /**
   * Place the camera for audio time `t`. Pure function of `t` — deterministic
   * across clients. Safe to call every frame; does nothing when disabled.
   * @param {number} t - audio position in seconds.
   */
  update(t) {
    if (!this._enabled) return;

    // Stage anchor in world space (Hall places it inside a group).
    this.stageAnchor.getWorldPosition(this._anchorWorld);

    // --- Graceful degradation: no track loaded -> Phase-3 fixed vantage. ---
    if (!this._shotT) {
      const swayX = Math.sin(t * 0.02) * 0.6;
      const swayY = Math.sin(t * 0.02 + Math.PI / 2) * 0.15;
      this._pos.set(
        this._basePos.x + swayX,
        this._basePos.y + swayY,
        this._basePos.z
      );
      this._target.set(
        this._anchorWorld.x,
        this._anchorWorld.y + 1.4,
        this._anchorWorld.z
      );
      this.camera.position.copy(this._pos);
      this.camera.lookAt(this._target);
      return;
    }

    // --- TV cut list ---
    const idx = this._findShot(t);
    const shot = this._shots[idx];
    const shotStart = this._shotT[idx];

    // World position = stage anchor world pos + posHint (stage space, meters).
    const hint = shot.posHint || [0, 2, 9];
    this._pos.set(
      this._anchorWorld.x + (hint[0] || 0),
      this._anchorWorld.y + (hint[1] || 0),
      this._anchorWorld.z + (hint[2] || 0)
    );

    // lookAt target by shot semantics.
    if (shot.lookAt === 'performer') {
      let kind = 'chest';
      if (shot.type === 'close-feet') kind = 'feet';
      else if (shot.type === 'close-face') kind = 'face';
      this._resolveFocus(kind, this._target);
    } else {
      // 'stage' (or anything else) -> anchor + 1.4m upper body.
      this._target.set(
        this._anchorWorld.x,
        this._anchorWorld.y + 1.4,
        this._anchorWorld.z
      );
    }

    // Deterministic handheld micro-sway, seeded by shot index, function of t.
    const local = t - shotStart;
    let amp = 0.02; // medium default
    const type = shot.type;
    if (type === 'close-face' || type === 'close-feet') amp = 0.035;
    else if (type === 'wide' || type === 'establishing') amp = 0.008;
    else amp = 0.02;

    const seed = idx * 7.31;
    const swayX = amp * (Math.sin(local * 1.7 + seed) * 0.6 + Math.sin(local * 3.9 + seed * 2.1) * 0.4);
    const swayY = amp * (Math.sin(local * 2.3 + seed * 1.3) * 0.6 + Math.sin(local * 4.7 + seed * 0.7) * 0.4);
    this._pos.x += swayX;
    this._pos.y += swayY;

    // Tiny target jitter (~30% of amplitude) so the frame breathes.
    const jitter = amp * 0.3;
    this._target.x += jitter * Math.sin(local * 1.9 + seed * 1.7);
    this._target.y += jitter * Math.sin(local * 2.9 + seed * 0.5);

    // HARD CUT: set fov directly; only rebuild projection when it changes.
    const fov = (typeof shot.fov === 'number') ? shot.fov : 40;
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    this.camera.position.copy(this._pos);
    this.camera.lookAt(this._target);
  }

  /**
   * Fill `out` with a world-space focus point. Uses the focus provider when
   * available; otherwise falls back to stage-anchor + fixed heights.
   * @param {'feet'|'chest'|'face'} kind
   * @param {THREE.Vector3} out
   */
  _resolveFocus(kind, out) {
    if (this._focusProvider) {
      this._focusProvider(kind, out);
      return;
    }
    let dy = 1.2; // chest
    if (kind === 'feet') dy = 0.12;
    else if (kind === 'face') dy = 1.6;
    out.set(this._anchorWorld.x, this._anchorWorld.y + dy, this._anchorWorld.z);
  }
}
