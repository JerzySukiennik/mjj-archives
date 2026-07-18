// MotionPlayer.js — audio-slaved skeletal playback of the captured MJ motion.
//
// Pure function of t: update(t) samples frame f = t*fps, slerps between the two
// adjacent frames, and writes local quats to bones by name (+ Hips translation).
// Same t twice => identical pose; scrub/seek/A-B loop "just work". NO runtime
// smoothing beyond adjacent-frame slerp — fidelity over smoothness (§9).
//
// Data lives in typed arrays (converted ONCE at load) so update() is O(1) per
// bone with zero allocation on the hot path.
//
// export class MotionPlayer
//   static async load(url) -> MotionPlayer   // fetch + parse + typed-array convert
//   bind(object3d, opts)                      // resolve bones + hips scale ONCE
//   update(t)                                 // absolute-time pose, pure fn of t
//   get hipsBone                              // for camera focus (world position)

import * as THREE from 'three';

// Module-scoped reusable temps — zero allocation in the hot path.
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

const HIPS_NAME = 'mixamorig:Hips';

export class MotionPlayer {
  constructor({ fps, duration, frameCount, boneNames, tracks, confidence, motionRefY }) {
    this.fps = fps;
    this.duration = duration;
    this.frameCount = frameCount;
    this.boneNames = boneNames;
    this._tracks = tracks;           // { [name]: { rot: Float32Array, pos?: Float32Array } }
    this._confidence = confidence;   // Float32Array (debug/verifier only)
    this.motionRefY = motionRefY;    // median standing hips Y (~0.94 m)

    // Bind state (populated by bind()).
    this._bound = false;
    this._bones = [];   // parallel: THREE.Bone | null
    this._rots = [];    // parallel: Float32Array (rot track for that bone)
    this._hipsBone = null;
    this._hipsRot = null;
    this._hipsPos = null;
    this._hipsBindLocal = new THREE.Vector3();
    this._posScale = 1;
    this._clampX = 2.5;
    this._clampZmin = -1.5;
    this._clampZmax = 2.0;
  }

  // --------------------------------------------------------------------------
  // load: fetch the 5.3MB motion JSON, one-shot parse, then IMMEDIATELY convert
  // every bone track to Float32Array and drop the parsed JS arrays.
  // --------------------------------------------------------------------------
  static async load(url) {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`motion fetch failed: HTTP ${res.status} for ${url}`);
    const json = await res.json(); // ~100-300ms one-shot parse at 5MB; acceptable.

    const fps = Number(json.fps) || 30;
    const duration = Number(json.duration) || 0;
    const frameCount = Number(json.frameCount) || 0;
    const boneNames = Array.isArray(json.boneNames) ? json.boneNames.slice() : [];

    const tracks = {};
    for (const name of boneNames) {
      const src = json.bones && json.bones[name];
      if (!src) continue;
      const track = {};
      if (src.rot) track.rot = new Float32Array(src.rot);          // frameCount*4 (xyzw)
      if (name === HIPS_NAME && src.pos) {
        track.pos = new Float32Array(src.pos);                      // frameCount*3
      }
      tracks[name] = track;
    }

    const confidence = json.confidence ? new Float32Array(json.confidence) : null;

    // motionRefY = median hips Y across all frames (standing-hip reference height).
    let motionRefY = 0.94;
    const hipsPos = tracks[HIPS_NAME] && tracks[HIPS_NAME].pos;
    if (hipsPos && frameCount > 0) {
      const ys = new Float64Array(frameCount);
      for (let i = 0; i < frameCount; i++) ys[i] = hipsPos[i * 3 + 1];
      ys.sort();
      const mid = frameCount >> 1;
      motionRefY = (frameCount & 1) ? ys[mid] : (ys[mid - 1] + ys[mid]) * 0.5;
      if (!Number.isFinite(motionRefY) || motionRefY <= 0) motionRefY = 0.94;
    }

    return new MotionPlayer({ fps, duration, frameCount, boneNames, tracks, confidence, motionRefY });
  }

  // --------------------------------------------------------------------------
  // bind: resolve the animated bones by EXACT name ONCE. Capture the Hips rest
  // local position BEFORE any motion is applied, and derive posScale so motion
  // meters map into the rig's hips-local units (handles cm-scale armatures).
  // --------------------------------------------------------------------------
  bind(object3d, opts = {}) {
    if (opts.clampX != null) this._clampX = opts.clampX;
    if (opts.clampZ) { this._clampZmin = opts.clampZ[0]; this._clampZmax = opts.clampZ[1]; }

    this._bones.length = 0;
    this._rots.length = 0;

    // GLTFLoader runs node names through PropertyBinding.sanitizeNodeName, which
    // STRIPS reserved chars (':' '.' '/' '[' ']'). The motion capture bone names
    // keep their colons ('mixamorig:Hips'), so an exact getObjectByName() finds
    // nothing on the loaded GLB (runtime bone is 'mixamorigHips'). Build a lookup
    // keyed by BOTH the raw and the sanitized name so binding is robust either way.
    const sanitize = (s) => s.replace(/[:.\/\[\]]/g, '');
    const byName = new Map();
    object3d.traverse((o) => {
      if (!o.name) return;
      if (!byName.has(o.name)) byName.set(o.name, o);
      const san = sanitize(o.name);
      if (!byName.has(san)) byName.set(san, o);
    });
    const resolveBone = (name) =>
      object3d.getObjectByName(name) || byName.get(name) || byName.get(sanitize(name)) || null;

    let missing = 0;
    for (const name of this.boneNames) {
      const track = this._tracks[name];
      const bone = resolveBone(name);
      if (!bone) missing++;
      this._bones.push(bone);
      this._rots.push(track && track.rot ? track.rot : null);

      if (name === HIPS_NAME) {
        this._hipsBone = bone;
        this._hipsRot = track && track.rot ? track.rot : null;
        this._hipsPos = track && track.pos ? track.pos : null;
        if (bone) {
          // Rest local position, captured before the first update() writes a pose.
          this._hipsBindLocal.copy(bone.position);
        }
      }
    }

    if (missing > 0) {
      console.info(`[MotionPlayer] ${missing}/${this.boneNames.length} bone(s) not found on model; skipped.`);
    }

    // posScale: rig hips-local standing height / motion-space standing height.
    const bindY = this._hipsBindLocal.y;
    this._posScale = (this.motionRefY > 0 && Number.isFinite(bindY) && bindY !== 0)
      ? bindY / this.motionRefY
      : 1;

    this._bound = true;
    return this;
  }

  // --------------------------------------------------------------------------
  // update: absolute-time pose. O(1) per bone, zero allocation.
  // --------------------------------------------------------------------------
  update(t) {
    if (!this._bound || this.frameCount <= 0) return;

    const n = this.frameCount;
    let f = t * this.fps;
    if (!Number.isFinite(f) || f < 0) f = 0;
    const maxF = n - 1 - 1e-6;
    if (f > maxF) f = maxF;
    const i0 = f | 0;
    const i1 = i0 + 1 < n ? i0 + 1 : n - 1;
    const alpha = f - i0;

    const bones = this._bones;
    const rots = this._rots;
    const base0 = i0 * 4;
    const base1 = i1 * 4;

    for (let b = 0; b < bones.length; b++) {
      const bone = bones[b];
      const rot = rots[b];
      if (!bone || !rot) continue;
      _qa.set(rot[base0], rot[base0 + 1], rot[base0 + 2], rot[base0 + 3]);
      _qb.set(rot[base1], rot[base1 + 1], rot[base1 + 2], rot[base1 + 3]);
      bone.quaternion.copy(_qa).slerp(_qb, alpha);
    }

    // Hips translation: lerp raw meters, clamp to stage bounds (safety net),
    // then scale into rig-local units and preserve any rest lateral offset.
    const pos = this._hipsPos;
    if (this._hipsBone && pos) {
      const p0 = i0 * 3;
      const p1 = i1 * 3;
      let x = pos[p0]     + (pos[p1]     - pos[p0])     * alpha;
      let y = pos[p0 + 1] + (pos[p1 + 1] - pos[p0 + 1]) * alpha;
      let z = pos[p0 + 2] + (pos[p1 + 2] - pos[p0 + 2]) * alpha;

      if (x > this._clampX) x = this._clampX; else if (x < -this._clampX) x = -this._clampX;
      if (z > this._clampZmax) z = this._clampZmax; else if (z < this._clampZmin) z = this._clampZmin;

      const s = this._posScale;
      this._hipsBone.position.set(
        x * s + this._hipsBindLocal.x,
        y * s,
        z * s + this._hipsBindLocal.z,
      );
    }
  }

  get hipsBone() { return this._hipsBone; }
}
