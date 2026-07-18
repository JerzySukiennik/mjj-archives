// Avatars.js — remote player silhouettes + floating nametags for MJJ Archives.
//
// One stylized silhouette (dark capsule, near-black with a faint emissive rim so
// it reads in the dim hall) plus a canvas-textured nametag Sprite floating above
// the head, for every player EXCEPT the local one. Network presence arrives at
// ~5 Hz; sync() only stores target pos/yaw, and update(dt) lerps toward those
// targets each frame so motion looks continuous. Zero allocations per frame.
//
//   const avatars = new Avatars(scene);
//   avatars.setLocalId(myPlayerId);
//   // on presence snapshot:
//   avatars.sync(playersArray);       // [{ id, name, pos:{x,y,z}, yaw }, ...]
//   // per frame:
//   avatars.update(dt);
//   avatars.dispose();

import * as THREE from 'three';

const RIM_COLOR = 0x2a2438;
const BODY_COLOR = 0x14121a;
const CAPSULE_HEIGHT = 1.2;    // cylindrical part; +2*radius total ≈ 1.7 m
const CAPSULE_RADIUS = 0.28;
const EYE_HEIGHT = 1.7;
const NAMETAG_Y = 2.15;        // above head
const LERP_RATE = 8;           // position lerp factor = min(1, LERP_RATE*dt)

// Shared geometry across all avatars (disposed once in dispose()).
let _sharedCapsuleGeo = null;
function capsuleGeometry() {
  if (!_sharedCapsuleGeo) {
    _sharedCapsuleGeo = new THREE.CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_HEIGHT, 6, 12);
  }
  return _sharedCapsuleGeo;
}

export class Avatars {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.scene = scene;
    this.localId = null;
    /** @type {Map<string, object>} id -> avatar record */
    this._avatars = new Map();
    this._seen = new Set(); // scratch set reused in sync()

    // Reused temporaries.
    this._tmpQuatA = new THREE.Quaternion();
    this._tmpQuatB = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  /** @param {string} id - local player id, so we never render ourselves. */
  setLocalId(id) {
    this.localId = id;
    if (id && this._avatars.has(id)) this._removeAvatar(id);
  }

  /**
   * Reconcile the avatar set against a presence snapshot. Stores targets only.
   * @param {Array<{id:string,name:string,pos:{x:number,y:number,z:number},yaw:number}>} players
   */
  sync(players) {
    this._seen.clear();
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p || !p.id || p.id === this.localId) continue;
      this._seen.add(p.id);

      let av = this._avatars.get(p.id);
      if (!av) av = this._createAvatar(p.id, p.name);
      else if (av.name !== p.name) this._setNametag(av, p.name);

      // Store targets (position at floor; group origin is feet).
      if (p.pos) {
        av.targetPos.set(p.pos.x, p.pos.y - EYE_HEIGHT, p.pos.z);
        if (!av.spawned) {
          av.group.position.copy(av.targetPos);
          av.spawned = true;
        }
      }
      if (typeof p.yaw === 'number') av.targetYaw = p.yaw;
    }

    // Remove avatars no longer present.
    for (const id of this._avatars.keys()) {
      if (!this._seen.has(id)) this._removeAvatar(id);
    }
  }

  /**
   * Per-frame smoothing toward network targets.
   * @param {number} dt - seconds since last frame.
   */
  update(dt) {
    if (dt <= 0) return;
    const posFactor = Math.min(1, LERP_RATE * dt);
    // Yaw slerp factor — slightly snappier so facing tracks well.
    const yawFactor = Math.min(1, LERP_RATE * dt);
    for (const av of this._avatars.values()) {
      if (!av.spawned) continue;
      av.group.position.lerp(av.targetPos, posFactor);

      // Shortest-arc yaw interpolation via quaternions about +Y.
      this._tmpQuatB.setFromAxisAngle(this._up, av.targetYaw);
      av.group.quaternion.slerp(this._tmpQuatB, yawFactor);
    }
  }

  dispose() {
    for (const id of Array.from(this._avatars.keys())) this._removeAvatar(id);
    this._avatars.clear();
    if (_sharedCapsuleGeo) {
      _sharedCapsuleGeo.dispose();
      _sharedCapsuleGeo = null;
    }
  }

  // ---- internals ---------------------------------------------------------

  _createAvatar(id, name) {
    const group = new THREE.Group();
    group.name = `Avatar_${id}`;

    const material = new THREE.MeshStandardMaterial({
      color: BODY_COLOR,
      emissive: RIM_COLOR,
      emissiveIntensity: 0.6,
      roughness: 0.7,
      metalness: 0.1,
    });
    const body = new THREE.Mesh(capsuleGeometry(), material);
    // Capsule centre sits at half total height so feet rest at group origin.
    body.position.y = CAPSULE_HEIGHT / 2 + CAPSULE_RADIUS;
    body.castShadow = true;
    body.receiveShadow = false;
    group.add(body);

    const av = {
      id,
      name: null,
      group,
      material,
      sprite: null,
      spriteMat: null,
      spriteTex: null,
      canvas: null,
      targetPos: new THREE.Vector3(),
      targetYaw: 0,
      spawned: false,
    };

    this._setNametag(av, name);
    this.scene.add(group);
    this._avatars.set(id, av);
    return av;
  }

  _setNametag(av, name) {
    av.name = name;
    const label = (name && String(name)) || '???';

    // Reuse the canvas/texture across renders; only redraw on name change.
    if (!av.canvas) {
      av.canvas = document.createElement('canvas');
      av.canvas.width = 256;
      av.canvas.height = 64;
    }
    const ctx = av.canvas.getContext('2d');
    ctx.clearRect(0, 0, av.canvas.width, av.canvas.height);
    ctx.font = 'bold 32px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Soft dark pill behind the text for legibility.
    const textW = Math.min(240, ctx.measureText(label).width + 28);
    const cx = av.canvas.width / 2;
    ctx.fillStyle = 'rgba(10, 8, 14, 0.72)';
    this._roundRect(ctx, cx - textW / 2, 10, textW, 44, 12);
    ctx.fill();
    ctx.fillStyle = '#f2eeff';
    ctx.fillText(label, cx, 33);

    if (!av.spriteTex) {
      av.spriteTex = new THREE.CanvasTexture(av.canvas);
      av.spriteMat = new THREE.SpriteMaterial({
        map: av.spriteTex,
        transparent: true,
        depthTest: false,
      });
      av.sprite = new THREE.Sprite(av.spriteMat);
      av.sprite.scale.set(1.4, 0.35, 1); // ~0.4 m tall on screen
      av.sprite.position.y = NAMETAG_Y;
      av.group.add(av.sprite);
    } else {
      av.spriteTex.needsUpdate = true;
    }
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  _removeAvatar(id) {
    const av = this._avatars.get(id);
    if (!av) return;
    this.scene.remove(av.group);
    av.material.dispose();
    if (av.spriteTex) av.spriteTex.dispose();
    if (av.spriteMat) av.spriteMat.dispose();
    // Shared capsule geometry is NOT disposed here (freed in dispose()).
    this._avatars.delete(id);
  }
}
