// PlaceholderHumanoid.js — built-in MJ stand-in used when mj.glb is absent.
// A ~1.75 m stylized humanoid as a real SkinnedMesh over a simple humanoid Bone
// hierarchy (hips/spine/chest/neck/head/arms/legs). Dark matte body with one
// WHITE GLOVE on the right hand so it reads as the MJ placeholder. Ships a
// procedurally authored looping AnimationClip so absolute-time scrubbing is
// visibly exercisable with no external assets.
//
// export function createPlaceholderHumanoid() -> { object3d, clip }

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Bone table: [name, parentIndex, localX, localY, localZ]. Local offsets stack
// up the hierarchy so each bone's WORLD bind position is the sum along its chain.
const BONES = [
  ['Hips',      -1, 0,     0.95,  0],   // 0  (root)
  ['Spine',      0, 0,     0.22,  0],   // 1
  ['Chest',      1, 0,     0.22,  0],   // 2
  ['Neck',       2, 0,     0.16,  0],   // 3
  ['Head',       3, 0,     0.14,  0],   // 4
  ['UpperArmL',  2, 0.20,  0.11,  0],   // 5
  ['ForeArmL',   5, 0,    -0.29,  0],   // 6
  ['HandL',      6, 0,    -0.26,  0],   // 7
  ['UpperArmR',  2, -0.20, 0.11,  0],   // 8
  ['ForeArmR',   8, 0,    -0.29,  0],   // 9
  ['HandR',      9, 0,    -0.26,  0],   // 10 (white glove)
  ['ThighL',     0, 0.10, -0.05,  0],   // 11
  ['ShinL',     11, 0,    -0.42,  0],   // 12
  ['FootL',     12, 0,    -0.42,  0.02],// 13
  ['ThighR',     0, -0.10,-0.05,  0],   // 14
  ['ShinR',     14, 0,    -0.42,  0],   // 15
  ['FootR',     15, 0,    -0.42,  0.02],// 16
];

export function createPlaceholderHumanoid() {
  // ---- Build bones and resolve world bind positions ----------------------
  const bones = BONES.map(([name]) => {
    const b = new THREE.Bone();
    b.name = name;
    return b;
  });
  const worldPos = [];
  BONES.forEach(([, parent, x, y, z], i) => {
    bones[i].position.set(x, y, z);
    if (parent >= 0) {
      bones[parent].add(bones[i]);
      worldPos[i] = worldPos[parent].clone().add(new THREE.Vector3(x, y, z));
    } else {
      worldPos[i] = new THREE.Vector3(x, y, z);
    }
  });

  // ---- Geometry: one skinned box per body segment, in WORLD/bind space ----
  // Each box is fully weighted (weight 1) to a single bone. When that bone
  // rotates the segment follows rigidly about the bone origin.
  function segBox(boneIndex, w, h, d, cx, cy, cz) {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(cx, cy, cz);
    const n = geo.attributes.position.count;
    const si = new Float32Array(n * 4);
    const sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      si[i * 4] = boneIndex;    // index 0 = this bone
      sw[i * 4] = 1;            // full weight
    }
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    return geo;
  }

  const P = (i) => worldPos[i];
  const mid = (a, b) => a.clone().add(b).multiplyScalar(0.5);

  const bodyParts = [];
  // Pelvis
  bodyParts.push(segBox(0, 0.34, 0.24, 0.22, P(0).x, P(0).y, 0));
  // Abdomen (spine)
  bodyParts.push(segBox(1, 0.30, 0.28, 0.20, P(1).x, P(1).y, 0));
  // Chest
  bodyParts.push(segBox(2, 0.42, 0.30, 0.24, P(2).x, P(2).y + 0.02, 0));
  // Neck
  bodyParts.push(segBox(3, 0.10, 0.14, 0.10, P(3).x, P(3).y, 0));
  // Head
  bodyParts.push(segBox(4, 0.22, 0.26, 0.24, P(4).x, P(4).y + 0.05, 0));
  // Fedora: brim + crown attached to Head bone
  bodyParts.push(segBox(4, 0.34, 0.03, 0.34, P(4).x, P(4).y + 0.17, 0));
  bodyParts.push(segBox(4, 0.24, 0.14, 0.24, P(4).x, P(4).y + 0.25, 0));

  // Left arm (dark)
  bodyParts.push(segBox(5, 0.11, 0.30, 0.11, ...mid(P(5), P(6)).toArray()));
  bodyParts.push(segBox(6, 0.10, 0.28, 0.10, ...mid(P(6), P(7)).toArray()));
  bodyParts.push(segBox(7, 0.10, 0.13, 0.07, P(7).x, P(7).y - 0.05, 0));
  // Right arm (dark upper/fore; glove is separate material)
  bodyParts.push(segBox(8, 0.11, 0.30, 0.11, ...mid(P(8), P(9)).toArray()));
  bodyParts.push(segBox(9, 0.10, 0.28, 0.10, ...mid(P(9), P(10)).toArray()));

  // Legs (high-water trousers dark; white socks accent at ankle)
  bodyParts.push(segBox(11, 0.15, 0.44, 0.15, ...mid(P(11), P(12)).toArray()));
  bodyParts.push(segBox(12, 0.12, 0.42, 0.12, P(12).x, P(12).y - 0.21 + 0.10, 0)); // shin (dark)
  bodyParts.push(segBox(14, 0.15, 0.44, 0.15, ...mid(P(14), P(15)).toArray()));
  bodyParts.push(segBox(15, 0.12, 0.42, 0.12, P(15).x, P(15).y - 0.21 + 0.10, 0));

  // Feet (black loafers)
  bodyParts.push(segBox(13, 0.13, 0.08, 0.30, P(13).x, P(13).y + 0.04, 0.08));
  bodyParts.push(segBox(16, 0.13, 0.08, 0.30, P(16).x, P(16).y + 0.04, 0.08));

  // White socks (short segment above the loafer)
  const sockParts = [];
  sockParts.push(segBox(12, 0.125, 0.10, 0.125, P(12).x, P(12).y - 0.20, 0));
  sockParts.push(segBox(15, 0.125, 0.10, 0.125, P(15).x, P(15).y - 0.20, 0));

  // Right hand = WHITE GLOVE (separate material)
  const gloveParts = [];
  gloveParts.push(segBox(10, 0.11, 0.14, 0.08, P(10).x, P(10).y - 0.05, 0));

  const bodyGeo = mergeGeometries(bodyParts, false);
  const sockGeo = mergeGeometries(sockParts, false);
  const gloveGeo = mergeGeometries(gloveParts, false);
  // Merge with groups so we get material indices 0 (body), 1 (socks), 2 (glove).
  const geometry = mergeGeometries([bodyGeo, sockGeo, gloveGeo], true);
  bodyParts.forEach((g) => g.dispose());
  sockParts.forEach((g) => g.dispose());
  gloveParts.forEach((g) => g.dispose());
  bodyGeo.dispose(); sockGeo.dispose(); gloveGeo.dispose();

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x111114, roughness: 0.72, metalness: 0.12 });
  const sockMat = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.85, metalness: 0.0 });
  const gloveMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.05, emissive: 0x222222 });

  const mesh = new THREE.SkinnedMesh(geometry, [bodyMat, sockMat, gloveMat]);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;

  // ---- Bind skeleton -----------------------------------------------------
  const root = bones[0];
  mesh.add(root);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton);

  const object3d = new THREE.Group();
  object3d.name = 'PlaceholderHumanoid';
  object3d.add(mesh);
  // Feet already rest at y≈0 in bind space (ankle ~0.06, loafer bottom ~0).

  const clip = buildGrooveClip();

  return { object3d, clip };
}

// ---------------------------------------------------------------------------
// Procedural looping groove clip (12 s, cleanly loops on a 2 s cycle).
function buildGrooveClip() {
  const duration = 12;
  const step = 0.25;
  const times = [];
  for (let t = 0; t <= duration + 1e-6; t += step) times.push(+t.toFixed(3));
  const CYC = 2 * Math.PI / 2.0; // 2 s per groove cycle

  const eulerTrack = (boneName, fn) => {
    const vals = new Float32Array(times.length * 4);
    const e = new THREE.Euler();
    const q = new THREE.Quaternion();
    times.forEach((t, i) => {
      const [rx, ry, rz] = fn(t);
      e.set(rx, ry, rz, 'XYZ');
      q.setFromEuler(e);
      vals[i * 4] = q.x; vals[i * 4 + 1] = q.y; vals[i * 4 + 2] = q.z; vals[i * 4 + 3] = q.w;
    });
    return new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times.slice(), vals);
  };

  const posTrack = (boneName, base, fn) => {
    const vals = new Float32Array(times.length * 3);
    times.forEach((t, i) => {
      const [dx, dy, dz] = fn(t);
      vals[i * 3] = base.x + dx; vals[i * 3 + 1] = base.y + dy; vals[i * 3 + 2] = base.z + dz;
    });
    return new THREE.VectorKeyframeTrack(`${boneName}.position`, times.slice(), vals);
  };

  const s = (t, ph = 0) => Math.sin(t * CYC + ph);
  const c = (t, ph = 0) => Math.cos(t * CYC + ph);

  const tracks = [
    // Hips: weight-shift sway + gentle bob + slight twist.
    posTrack('Hips', new THREE.Vector3(0, 0.95, 0), (t) => [0.05 * s(t), -0.02 * (1 - c(t * 2)), 0]),
    eulerTrack('Hips', (t) => [0, 0.12 * s(t), 0.06 * s(t)]),
    // Spine counter-twist.
    eulerTrack('Spine', (t) => [0.03 * s(t, Math.PI / 2), -0.08 * s(t), -0.04 * s(t)]),
    eulerTrack('Chest', (t) => [0.02 * s(t, Math.PI), 0.05 * s(t), 0]),
    // Head nod + look.
    eulerTrack('Head', (t) => [0.10 * s(t * 2) + 0.04, 0.08 * s(t, Math.PI / 3), 0]),
    // Arms swing (opposite phase), with a raised-forearm groove.
    eulerTrack('UpperArmL', (t) => [0.25 * s(t) - 0.05, 0, 0.35 + 0.15 * s(t, Math.PI)]),
    eulerTrack('ForeArmL', (t) => [-0.4 - 0.2 * Math.max(0, s(t)), 0, 0]),
    eulerTrack('UpperArmR', (t) => [0.25 * s(t, Math.PI) - 0.05, 0, -0.35 - 0.15 * s(t)]),
    eulerTrack('ForeArmR', (t) => [-0.4 - 0.2 * Math.max(0, s(t, Math.PI)), 0, 0]),
    eulerTrack('HandR', (t) => [0, 0, 0.2 * s(t)]),
    // Legs: subtle knee bend on the weighted side (stepping groove).
    eulerTrack('ThighL', (t) => [0.15 * Math.max(0, -s(t)), 0, 0]),
    eulerTrack('ShinL', (t) => [-0.25 * Math.max(0, -s(t)), 0, 0]),
    eulerTrack('ThighR', (t) => [0.15 * Math.max(0, s(t)), 0, 0]),
    eulerTrack('ShinR', (t) => [-0.25 * Math.max(0, s(t)), 0, 0]),
  ];

  const clip = new THREE.AnimationClip('placeholder-groove', duration, tracks);
  return clip;
}
