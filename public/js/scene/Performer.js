// Performer.js — MJ performer wrapper. Loads manifest.model via GLTFLoader and
// on ANY failure falls back silently to the built-in PlaceholderHumanoid.
// Owns an AnimationMixer driven by ABSOLUTE audio time (the sync contract):
// update(t) sets mixer time absolutely — NEVER accumulates deltaTime.
//
// export class Performer
//   static async load(manifest, { onProgress }) -> Performer
//   update(timeSeconds)   // absolute-time pose; deterministic + scrub-safe
//   get object3d
//   get usingPlaceholder
//   dispose()

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createPlaceholderHumanoid } from './PlaceholderHumanoid.js';

export class Performer {
  constructor({ object3d, mixer, action, clip, usingPlaceholder }) {
    this._object3d = object3d;
    this._mixer = mixer;
    this._action = action;
    this._clip = clip;
    this._usingPlaceholder = usingPlaceholder;
    this._clipDuration = clip ? clip.duration : 0;
  }

  static async load(manifest, { onProgress } = {}) {
    const modelPath = manifest && manifest.model;
    let gltf = null;

    if (modelPath) {
      try {
        const loader = new GLTFLoader();
        gltf = await loader.loadAsync(modelPath, (evt) => {
          if (onProgress && evt && evt.total) onProgress(evt.loaded / evt.total);
        });
      } catch (err) {
        // 404 / parse / anything — never throw for a missing model.
        console.info('[Performer] model unavailable, using placeholder humanoid:', modelPath);
        gltf = null;
      }
    }

    if (gltf && gltf.scene) {
      return Performer._fromGltf(gltf, manifest);
    }
    return Performer._fromPlaceholder();
  }

  static _fromGltf(gltf, manifest) {
    const object3d = gltf.scene;
    object3d.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; }
    });
    Performer._dropToFloor(object3d);

    const mixer = new THREE.AnimationMixer(object3d);
    // Animation source priority: manifest.motion (null in Phase 1) is handled
    // by the caller/loader; here we take the first embedded clip if present.
    const clip = (gltf.animations && gltf.animations.length) ? gltf.animations[0] : null;
    let action = null;
    if (clip) {
      action = mixer.clipAction(clip);
      action.play();
      action.paused = false; // time is driven externally, not by paused flag
    }
    return new Performer({ object3d, mixer, action, clip, usingPlaceholder: false });
  }

  static _fromPlaceholder() {
    const { object3d, clip } = createPlaceholderHumanoid();
    const mixer = new THREE.AnimationMixer(object3d);
    const action = mixer.clipAction(clip);
    action.play();
    action.paused = false;
    return new Performer({ object3d, mixer, action, clip, usingPlaceholder: true });
  }

  static _dropToFloor(object3d) {
    object3d.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(object3d);
    if (Number.isFinite(box.min.y)) object3d.position.y -= box.min.y;
  }

  // ---- THE CORE CONTRACT -------------------------------------------------
  // Absolute-time set. update(5) twice => identical pose; update(10) after
  // update(200) => snaps backward instantly. No deltaTime accumulation.
  update(timeSeconds) {
    if (!this._mixer) return;
    let t = timeSeconds;
    if (!Number.isFinite(t) || t < 0) t = 0;

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
