// DirectorCamera.js — shared cinematic camera for the performance.
//
// PHASE 3 (now): a single fixed cinematic shot on the stage, with a very slow
// drift computed PURELY from the audio time `t`. Because the shot is a pure
// deterministic function of `t` (no deltaTime, no local RNG, no wall clock),
// every client that calls update(t) with the same audio position renders the
// EXACT same framing — which is what "host dictates the camera for everyone"
// requires. Never introduce deltaTime, Date.now(), or per-instance state that
// diverges between clients.
//
// PHASE 4 CONTRACT (frozen):
//   static async fromTrack(url, camera, stageAnchor) will fetch
//   camera-track.json — a cut list of shots keyed by timestamp — and return a
//   DirectorCamera whose update(t) performs a lookup: find the active shot for
//   time `t` (the TV-cut at or before `t`) and place the camera accordingly,
//   still as a pure function of `t`. The update(t) SIGNATURE MUST NOT CHANGE;
//   callers depend on `update(audioSeconds)` staying stable across phases.

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

    // Reused temporaries — zero allocation in update().
    this._basePos = new THREE.Vector3(0, 2.4, 9.5);   // fixed cinematic vantage
    this._pos = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._anchorWorld = new THREE.Vector3();
  }

  /** @param {boolean} on */
  setEnabled(on) {
    this._enabled = !!on;
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

    // Very slow deterministic sway derived from t only.
    const swayX = Math.sin(t * 0.02) * 0.6;          // gentle lateral drift
    const swayY = Math.sin(t * 0.02 + Math.PI / 2) * 0.15;

    this._pos.set(
      this._basePos.x + swayX,
      this._basePos.y + swayY,
      this._basePos.z
    );

    // Aim at the performer's upper body (anchor + ~1.4 m).
    this._target.set(
      this._anchorWorld.x,
      this._anchorWorld.y + 1.4,
      this._anchorWorld.z
    );

    this.camera.position.copy(this._pos);
    this.camera.lookAt(this._target);
  }
}
