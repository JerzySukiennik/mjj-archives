// Performer.js — MJ performer wrapper. Loads manifest.model via GLTFLoader and
// on ANY failure falls back silently to the built-in PlaceholderHumanoid.
//
// Animation is a pure function of ABSOLUTE audio time (the sync contract):
//   - With captured motion (manifest.motion): a MotionPlayer samples frame
//     f = t*fps and slerps adjacent frames. NO mixer/idle-clip is used.
//   - Without motion (Phase-1 / placeholder): an AnimationMixer is advanced to
//     absolute time — NEVER accumulates deltaTime.
//
// export class Performer
//   static async load(manifest, { onProgress }) -> Performer
//   update(timeSeconds)                 // absolute-time pose; deterministic + scrub-safe
//   setAnchor(worldVec3)                // stage anchor + stored floor offset
//   getFocusPoint(kind, outVec3)        // 'feet'|'chest'|'face' for the director cam
//   get object3d
//   get usingPlaceholder
//   dispose()

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createPlaceholderHumanoid } from './PlaceholderHumanoid.js';
import { MotionPlayer } from './MotionPlayer.js';

// Reused temps for getFocusPoint (zero allocation on the camera hot path).
const _hipsWorld = new THREE.Vector3();

export class Performer {
  constructor({ object3d, mixer, action, clip, usingPlaceholder, motion, floorOffset }) {
    this._object3d = object3d;
    this._mixer = mixer;
    this._action = action;
    this._clip = clip;
    this._usingPlaceholder = usingPlaceholder;
    this._clipDuration = clip ? clip.duration : 0;
    this._motion = motion || null;
    this._floorOffset = floorOffset || 0;
    this._anchorWorld = new THREE.Vector3();
  }

  static async load(manifest, { onProgress } = {}) {
    const modelPath = manifest && manifest.model;
    const motionPath = manifest && manifest.motion;

    // GLB and motion load in PARALLEL. Because boot awaits this before the
    // ready-check, motion parsing automatically gates 'ready'.
    const gltfP = (async () => {
      if (!modelPath) return null;
      try {
        const loader = new GLTFLoader();
        return await loader.loadAsync(modelPath, (evt) => {
          if (onProgress && evt && evt.total) onProgress(evt.loaded / evt.total);
        });
      } catch (err) {
        console.info('[Performer] model unavailable, using placeholder humanoid:', modelPath);
        return null;
      }
    })();

    const motionP = (async () => {
      if (!motionPath) return null;
      try {
        return await MotionPlayer.load(motionPath);
      } catch (err) {
        // Real GLB may still exist — log loudly and fall back to the clip/T-pose path.
        console.error('[Performer] motion load failed, falling back to embedded clip:', err && err.message);
        return null;
      }
    })();

    const [gltf, motion] = await Promise.all([gltfP, motionP]);

    if (gltf && gltf.scene) {
      return Performer._fromGltf(gltf, manifest, motion);
    }
    return Performer._fromPlaceholder();
  }

  static _fromGltf(gltf, manifest, motion) {
    const object3d = gltf.scene;
    object3d.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; }
    });
    const floorOffset = Performer._measureFloorOffset(object3d);

    let mixer = null;
    let action = null;
    let clip = null;

    if (motion) {
      // Captured-motion path: bind the skeleton, skip the mixer/idle-clip entirely.
      try {
        motion.bind(object3d);
      } catch (err) {
        console.error('[Performer] motion bind failed, falling back to clip path:', err && err.message);
        motion = null;
      }
    }

    if (!motion) {
      // Phase-1 embedded-clip / T-pose path.
      mixer = new THREE.AnimationMixer(object3d);
      clip = (gltf.animations && gltf.animations.length) ? gltf.animations[0] : null;
      if (clip) {
        action = mixer.clipAction(clip);
        action.play();
        action.paused = false; // time is driven externally, not by paused flag
      }
    }

    const performer = new Performer({
      object3d, mixer, action, clip, usingPlaceholder: false, motion, floorOffset,
    });

    // Guarded dynamic costume hook — Costume.js is built by another task; the
    // hook must not break when the file is absent or throws.
    import('./Costume.js')
      .then((mod) => { if (mod && mod.applyCostume) mod.applyCostume(object3d); })
      .catch((e) => { console.info('[Performer] costume unavailable', e && e.message); });

    return performer;
  }

  static _fromPlaceholder() {
    const { object3d, clip } = createPlaceholderHumanoid();
    const mixer = new THREE.AnimationMixer(object3d);
    const action = mixer.clipAction(clip);
    action.play();
    action.paused = false;
    const floorOffset = Performer._measureFloorOffset(object3d);
    return new Performer({
      object3d, mixer, action, clip, usingPlaceholder: true, motion: null, floorOffset,
    });
  }

  // Measure the drop-to-floor offset in the BIND pose (before motion applies):
  // the vertical amount that raises the model's lowest point to y=0 within its
  // own local space. Stored (not clobbered) so setAnchor can compose it on top.
  static _measureFloorOffset(object3d) {
    const prevY = object3d.position.y;
    object3d.position.y = 0;
    object3d.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(object3d);
    object3d.position.y = prevY;
    return Number.isFinite(box.min.y) ? -box.min.y : 0;
  }

  // ---- THE CORE CONTRACT -------------------------------------------------
  // Absolute-time set. update(5) twice => identical pose; update(10) after
  // update(200) => snaps backward instantly. No deltaTime accumulation.
  update(timeSeconds) {
    let t = timeSeconds;
    if (!Number.isFinite(t) || t < 0) t = 0;

    if (this._motion) {
      this._motion.update(t);
      return;
    }

    if (!this._mixer) return;

    if (this._clipDuration > 0) {
      if (this._usingPlaceholder) {
        // Looping groove clip: wrap into [0, duration).
        t = t % this._clipDuration;
      } else {
        // Full-length motion: clamp so times past the end hold the last pose.
        if (t > this._clipDuration) t = this._clipDuration;
      }
    }

    // mixer.setTime(t) semantics done explicitly: reset accumulator to 0 then
    // advance to the absolute target. This is a pure function of t.
    this._mixer.time = 0;
    if (this._action) this._action.time = 0;
    this._mixer.update(t);
  }

  // Place the performer at the stage anchor, composing the stored floor offset
  // on top so the feet land on the stage floor (fixes the Phase-1 clobber where
  // a bare position.copy() overwrote the drop-to-floor).
  setAnchor(worldVec3) {
    this._anchorWorld.copy(worldVec3);
    this._object3d.position.set(worldVec3.x, worldVec3.y + this._floorOffset, worldVec3.z);
  }

  // Focus points for the DirectorCamera. Based on the hips world position when
  // motion is bound; falls back to stage-anchor heights otherwise.
  getFocusPoint(kind, out) {
    const target = out || new THREE.Vector3();
    const hips = this._motion && this._motion.hipsBone;
    if (hips) {
      hips.getWorldPosition(_hipsWorld);
      const x = _hipsWorld.x;
      const z = _hipsWorld.z;
      const hipsY = _hipsWorld.y;
      const feetY = this._anchorWorld.y + this._floorOffset + 0.12;
      if (kind === 'feet') return target.set(x, feetY, z);
      if (kind === 'face') return target.set(x, hipsY + 0.65, z);
      return target.set(x, hipsY + 0.35, z); // chest (default)
    }
    // Fallback: stage-anchor-based heights (placeholder / no hips).
    const baseY = this._anchorWorld.y + this._floorOffset;
    const x = this._object3d.position.x;
    const z = this._object3d.position.z;
    if (kind === 'feet') return target.set(x, baseY + 0.12, z);
    if (kind === 'face') return target.set(x, baseY + 1.55, z);
    return target.set(x, baseY + 1.25, z); // chest (default)
  }

  get object3d() { return this._object3d; }
  get usingPlaceholder() { return this._usingPlaceholder; }
  get clipDuration() { return this._clipDuration; }

  dispose() {
    if (this._mixer) this._mixer.stopAllAction();
    this._object3d?.traverse?.((o) => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.geometry?.dispose?.();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((mm) => mm.dispose?.());
        else m?.dispose?.();
      }
    });
  }
}
