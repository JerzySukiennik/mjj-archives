// WalkControls.js — first-person pre-show movement for MJJ Archives Phase 3.
//
// Pointer-lock mouse look (yaw + pitch, pitch clamped to ±80°) plus WASD
// movement in yaw space at ~3 m/s, at a fixed eye height. The avatar is
// clamped to an axis-aligned box matching the hall's seating area IN FRONT of
// the stage, so players never walk onto/through the stage geometry.
//
// This is a PURE INPUT module: it reads keyboard/mouse and integrates the
// camera position. It never touches Firestore, audio, or performance animation.
// Using deltaTime here is correct — movement is interactive input, not the
// audio-slaved performance (which must stay a pure function of audio time).
//
//   const walk = new WalkControls(camera, renderer.domElement, { bounds });
//   walk.enable();                 // requests pointer lock on next canvas click
//   ... per frame: walk.update(dt);
//   const { pos, yaw } = walk.getPose();   // feed to Presence.updatePose
//   walk.disable();                // exits pointer lock + unbinds listeners
//
// Hall reference (see scene/Hall.js): stage front at z=0, upstage toward -z;
// audience seating rows run z≈6..30 in front of the stage. Default bounds keep
// players in the near seating apron (z:[4,16]) and off the stage.

import * as THREE from 'three';

const EYE_HEIGHT = 1.7;   // camera height above the local floor (metres)
const SPEED = 3.0;        // walk speed (m/s)
// Stage geometry (must match scene/Hall.js): front edge at z=0, riser 1.2 m.
// Walking up is a smooth "stair" blend over the first 1.5 m past the edge.
const STAGE_H = 1.2;
const STAGE_STEP = 1.5;
function floorHeightAt(z) {
  if (z >= 0) return 0;                       // house floor
  if (z <= -STAGE_STEP) return STAGE_H;       // on the stage
  const t = -z / STAGE_STEP;                  // 0..1 across the step zone
  return STAGE_H * t * t * (3 - 2 * t);       // smoothstep ramp
}
const PITCH_LIMIT = THREE.MathUtils.degToRad(80);
const LOOK_SENS = 0.0022; // radians per pixel of mouse movement

export class WalkControls {
  /**
   * @param {THREE.PerspectiveCamera} camera - the shared scene camera.
   * @param {HTMLElement} domElement - canvas element used for pointer lock.
   * @param {{ bounds?: { minX:number, maxX:number, minZ:number, maxZ:number } }} [opts]
   */
  constructor(camera, domElement, { bounds } = {}) {
    this.camera = camera;
    this.dom = domElement;

    // AABB of the walkable seating apron (in front of the stage).
    this.bounds = bounds || { minX: -9, maxX: 9, minZ: 4, maxZ: 16 };

    this._enabled = false;
    this._locked = false;

    // Orientation state (radians). yaw about +Y, pitch about local X.
    this._yaw = Math.PI;   // face -z (toward the stage) by default
    this._pitch = 0;

    // Position — start centred in the seating apron.
    this._pos = new THREE.Vector3(
      0,
      EYE_HEIGHT,
      (this.bounds.minZ + this.bounds.maxZ) * 0.5
    );

    // Held movement keys.
    this._keys = { forward: false, back: false, left: false, right: false };

    // Reused temporaries — zero allocation in update().
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._forwardVec = new THREE.Vector3();
    this._rightVec = new THREE.Vector3();
    this._move = new THREE.Vector3();

    // Bound handlers (stable references so we can unbind).
    this._onClick = this._requestLock.bind(this);
    this._onLockChange = this._handleLockChange.bind(this);
    this._onMouseMove = this._handleMouseMove.bind(this);
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onKeyUp = this._handleKeyUp.bind(this);

    this._applyOrientation();
  }

  /** Begin listening; pointer lock is requested on the next canvas click. */
  enable() {
    if (this._enabled) return;
    this._enabled = true;
    this.dom.addEventListener('click', this._onClick);
    document.addEventListener('pointerlockchange', this._onLockChange);
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);
  }

  /** Exit pointer lock and unbind everything; movement stops. */
  disable() {
    if (!this._enabled) return;
    this._enabled = false;
    this.dom.removeEventListener('click', this._onClick);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup', this._onKeyUp);
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
    this._locked = false;
    this._keys.forward = this._keys.back = this._keys.left = this._keys.right = false;
  }

  /**
   * Integrate movement for this frame.
   * @param {number} dt - seconds since last frame.
   */
  update(dt) {
    if (!this._enabled || dt <= 0) return;

    // Planar forward/right derived from yaw only (no vertical drift).
    const sinY = Math.sin(this._yaw);
    const cosY = Math.cos(this._yaw);
    // Camera looks down -z at yaw=0 in YXZ; forward = (-sinY, 0, -cosY).
    this._forwardVec.set(-sinY, 0, -cosY);
    this._rightVec.set(cosY, 0, -sinY);

    this._move.set(0, 0, 0);
    if (this._keys.forward) this._move.add(this._forwardVec);
    if (this._keys.back) this._move.sub(this._forwardVec);
    if (this._keys.right) this._move.add(this._rightVec);
    if (this._keys.left) this._move.sub(this._rightVec);

    if (this._move.lengthSq() > 0) {
      this._move.normalize().multiplyScalar(SPEED * dt);
      this._pos.x += this._move.x;
      this._pos.z += this._move.z;
      // Clamp to the seating AABB.
      const b = this.bounds;
      if (this._pos.x < b.minX) this._pos.x = b.minX;
      else if (this._pos.x > b.maxX) this._pos.x = b.maxX;
      if (this._pos.z < b.minZ) this._pos.z = b.minZ;
      else if (this._pos.z > b.maxZ) this._pos.z = b.maxZ;
    }
    this._pos.y = floorHeightAt(this._pos.z) + EYE_HEIGHT;

    this.camera.position.copy(this._pos);
    this._applyOrientation();
  }

  /**
   * @returns {{ pos: {x:number,y:number,z:number}, yaw:number }}
   */
  getPose() {
    return {
      pos: { x: this._pos.x, y: this._pos.y, z: this._pos.z },
      yaw: this._yaw,
    };
  }

  // ---- internals ---------------------------------------------------------

  _requestLock() {
    if (this._enabled && !this._locked) this.dom.requestPointerLock();
  }

  _handleLockChange() {
    this._locked = document.pointerLockElement === this.dom;
    if (this._locked) {
      document.addEventListener('mousemove', this._onMouseMove);
    } else {
      document.removeEventListener('mousemove', this._onMouseMove);
      // Drop held keys so we don't drift while unlocked.
      this._keys.forward = this._keys.back = this._keys.left = this._keys.right = false;
    }
  }

  _handleMouseMove(e) {
    if (!this._locked) return;
    this._yaw -= e.movementX * LOOK_SENS;
    this._pitch -= e.movementY * LOOK_SENS;
    if (this._pitch > PITCH_LIMIT) this._pitch = PITCH_LIMIT;
    else if (this._pitch < -PITCH_LIMIT) this._pitch = -PITCH_LIMIT;
    this._applyOrientation();
  }

  _applyOrientation() {
    this._euler.set(this._pitch, this._yaw, 0);
    this.camera.quaternion.setFromEuler(this._euler);
  }

  _handleKeyDown(e) {
    if (!this._locked) return;
    this._setKey(e.code, true);
  }

  _handleKeyUp(e) {
    this._setKey(e.code, false);
  }

  _setKey(code, down) {
    switch (code) {
      case 'KeyW': case 'ArrowUp': this._keys.forward = down; break;
      case 'KeyS': case 'ArrowDown': this._keys.back = down; break;
      case 'KeyA': case 'ArrowLeft': this._keys.left = down; break;
      case 'KeyD': case 'ArrowRight': this._keys.right = down; break;
      default: break;
    }
  }
}
