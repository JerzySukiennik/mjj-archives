// Costume.js — dress the vanguard (soldier.glb Mixamo rig) as Motown-25 Michael
// Jackson at runtime. Pure three.js, no project imports. Synchronous & idempotent.
//
//   import { applyCostume } from './scene/Costume.js';
//   applyCostume(gltfScene);   // safe to call on any Object3D; never throws
//
// Strategy (see costumeDesign): the body is ONE skinned primitive
// (`vanguard_Mesh` / `VanguardBodyMat`). We do NOT add body geometry — instead we
// classify every triangle into a costume region by its dominant skin-weight bone +
// bind-pose position, reorder the index buffer by region, and hand the mesh a
// material array (clearGroups + addGroup). The visor is hidden, and a small
// procedural fedora (< 1k tris) is parented rigidly to the Head bone.
//
// Silhouette sells it: black sequined jacket + high-water trousers + WHITE SOCKS
// band + black loafers + fedora + one white glove. Tasteful > perfect; no face.

import * as THREE from 'three';

// ---- region ids (also used directly as material-array indices) ---------------
const R_SKIN     = 0; // keep original diffuse map (head, left hand, remainder)
const R_LOAFERS  = 1; // black shoes
const R_SOCKS    = 2; // pure white — the critical high-water cue
const R_TROUSERS = 3; // near-black high-waters
const R_JACKET   = 4; // sequined black jacket
const R_SHIRT    = 5; // white shirt (narrow front chest wedge)
const R_GLOVE    = 6; // white sequined glove (right hand)
const REGION_COUNT = 7;

// Tie-break priority when a triangle's 3 verts vote for 3 different regions.
// Small, high-signal cues win so they never get swallowed by big regions.
const PRIORITY = new Float32Array(REGION_COUNT);
PRIORITY[R_SKIN]     = 0;
PRIORITY[R_TROUSERS] = 1;
PRIORITY[R_JACKET]   = 2;
PRIORITY[R_LOAFERS]  = 3;
PRIORITY[R_SHIRT]    = 4;
PRIORITY[R_GLOVE]    = 5;
PRIORITY[R_SOCKS]    = 6;

const ASSUMED_HEIGHT_M = 1.75; // MJ ~ real-world height, for unit scaling

export function applyCostume(root) {
  if (!root || typeof root.traverse !== 'function') {
    console.warn('[Costume] applyCostume: no valid root');
    return;
  }
  if (root.userData && root.userData.costumeApplied) return;

  try {
    root.updateWorldMatrix(true, true);
  } catch (e) { /* non-fatal */ }

  // Step 1 — hide the sci-fi visor floating in front of the face.
  try {
    const visor = root.getObjectByName('vanguard_visor');
    if (visor) visor.visible = false;
    else console.info('[Costume] vanguard_visor not found (skipping visor hide)');
  } catch (e) {
    console.warn('[Costume] visor hide failed:', e && e.message);
  }

  // Step 2 — region-map & re-material the body mesh.
  let noiseTex = null;
  try {
    noiseTex = makeSparkleTexture();
    remapBody(root, noiseTex);
  } catch (e) {
    console.warn('[Costume] body remap failed (mesh left as-is):', e && e.message);
  }

  // Step 3 — procedural fedora on the Head bone.
  try {
    attachFedora(root);
  } catch (e) {
    console.warn('[Costume] fedora attach failed:', e && e.message);
  }

  if (!root.userData) root.userData = {};
  root.userData.costumeApplied = true;
}

// ---------------------------------------------------------------------------
// Body: classify every triangle, reorder index by region, assign material array
// ---------------------------------------------------------------------------
function remapBody(root, noiseTex) {
  const mesh = root.getObjectByName('vanguard_Mesh');
  if (!mesh || !mesh.isSkinnedMesh) {
    console.info('[Costume] vanguard_Mesh (skinned) not found — no body remap');
    return;
  }

  const geo = mesh.geometry;
  const pos = geo.attributes.position;   // bind-pose positions (skin bind space)
  const sIdx = geo.attributes.skinIndex;
  const sWgt = geo.attributes.skinWeight;
  const skeleton = mesh.skeleton;
  if (!pos || !sIdx || !sWgt || !skeleton) {
    console.info('[Costume] body mesh missing skin/position data — no remap');
    return;
  }

  const boneNames = skeleton.bones.map((b) => (b && b.name) || '');
  // GLTFLoader sanitizes node names (strips ':'), so runtime bones read as
  // 'mixamorigHips' not 'mixamorig:Hips'. All matching below is suffix-based.
  const comp = (attr, v, k) => (k === 0 ? attr.getX(v) : k === 1 ? attr.getY(v) : k === 2 ? attr.getZ(v) : attr.getW(v));

  // Bone bind positions in the SAME space as the vertex positions:
  // bindPos = inverse(inverseBindMatrix) translation.
  const _m = new THREE.Matrix4();
  const boneBindPos = boneNames.map((_, i) => {
    const inv = skeleton.boneInverses && skeleton.boneInverses[i];
    if (!inv) return new THREE.Vector3();
    _m.copy(inv).invert();
    return new THREE.Vector3().setFromMatrixPosition(_m);
  });

  // Model scale: bind-pose vertical extent -> units per real meter.
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const modelHeight = (isFinite(minY) && isFinite(maxY) && maxY > minY) ? (maxY - minY) : 1;
  const unitsPerM = modelHeight / ASSUMED_HEIGHT_M;

  // Ankle height: from foot bone bind Y (avg of left/right if present).
  const ankleY = averageBoneY(boneNames, boneBindPos, [/LeftFoot$/, /RightFoot$/], minY);
  const sockTopY = ankleY + 0.14 * unitsPerM; // socks below this on the calf

  // Front (+/-z) direction: toe is forward of the foot.
  const footZ = boneZ(boneNames, boneBindPos, /LeftFoot$/);
  const toeZ = boneZ(boneNames, boneBindPos, /LeftToeBase$/);
  const frontSign = (isFinite(toeZ) && isFinite(footZ) && (toeZ - footZ) !== 0)
    ? Math.sign(toeZ - footZ) : 1;
  const spineZ = boneZ(boneNames, boneBindPos, /Spine1$/);
  const shirtZThresh = (isFinite(spineZ) ? spineZ : 0); // front of the chest
  const shirtHalfWidth = 0.08 * unitsPerM;

  // Per-vertex region.
  const vCount = pos.count;
  const vRegion = new Uint8Array(vCount);
  for (let v = 0; v < vCount; v++) {
    // dominant-weight bone
    let bestW = -1, bestBone = 0;
    for (let k = 0; k < 4; k++) {
      const w = comp(sWgt, v, k);
      if (w > bestW) { bestW = w; bestBone = comp(sIdx, v, k); }
    }
    const name = boneNames[bestBone] || '';
    vRegion[v] = classifyVertex(
      name, pos.getX(v), pos.getY(v), pos.getZ(v),
      sockTopY, frontSign, shirtZThresh, shirtHalfWidth,
    );
  }

  // Triangles -> region (majority vote; ties by PRIORITY). Reorder index.
  const index = geo.index;
  if (!index) {
    console.info('[Costume] body geometry not indexed — no remap');
    return;
  }
  const src = index.array;
  const triCount = (src.length / 3) | 0;
  const triRegion = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const a = src[t * 3], b = src[t * 3 + 1], c = src[t * 3 + 2];
    triRegion[t] = voteRegion(vRegion[a], vRegion[b], vRegion[c]);
  }

  // Bucket triangles by region, then flatten into a new index in region order.
  const buckets = [];
  for (let r = 0; r < REGION_COUNT; r++) buckets.push([]);
  for (let t = 0; t < triCount; t++) buckets[triRegion[t]].push(t);

  const Ctor = src.constructor; // preserve Uint16Array / Uint32Array
  const out = new Ctor(src.length);
  geo.clearGroups();
  let write = 0;
  for (let r = 0; r < REGION_COUNT; r++) {
    const bucket = buckets[r];
    if (bucket.length === 0) continue;
    const start = write;
    for (let i = 0; i < bucket.length; i++) {
      const t = bucket[i];
      out[write++] = src[t * 3];
      out[write++] = src[t * 3 + 1];
      out[write++] = src[t * 3 + 2];
    }
    geo.addGroup(start, bucket.length * 3, r); // matIndex === region id
  }
  index.array.set(out);
  index.needsUpdate = true;

  // Build the material array (index === region id). Original material stays SKIN.
  const orig = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const skinMat = orig ? orig.clone() : new THREE.MeshStandardMaterial({ color: 0xb98a63 });

  const jacket = new THREE.MeshStandardMaterial({
    color: 0x0a0a0c, metalness: 0.85, roughness: 0.28, envMapIntensity: 1.5,
  });
  const glove = new THREE.MeshStandardMaterial({
    color: 0xffffff, metalness: 0.4, roughness: 0.35, envMapIntensity: 1.2,
  });
  if (noiseTex) {
    jacket.roughnessMap = noiseTex;
    glove.roughnessMap = noiseTex;
  }

  const mats = new Array(REGION_COUNT);
  mats[R_SKIN]     = skinMat;
  mats[R_LOAFERS]  = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, metalness: 0.1, roughness: 0.25 });
  mats[R_SOCKS]    = new THREE.MeshStandardMaterial({ color: 0xf5f5f5, metalness: 0.0, roughness: 0.8 });
  mats[R_TROUSERS] = new THREE.MeshStandardMaterial({ color: 0x101010, metalness: 0.0, roughness: 0.85 });
  mats[R_JACKET]   = jacket;
  mats[R_SHIRT]    = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, metalness: 0.0, roughness: 0.6 });
  mats[R_GLOVE]    = glove;

  mesh.material = mats;
}

function classifyVertex(name, x, y, z, sockTopY, frontSign, shirtZThresh, shirtHalfWidth) {
  // Feet/toes -> loafers.
  if (/Foot$|ToeBase$|Toe_End$/.test(name)) return R_LOAFERS;

  // Calf (LeftLeg/RightLeg, NOT UpLeg): sock band below ankle+band, else trouser.
  if (/(Left|Right)Leg$/.test(name)) {
    return (y < sockTopY) ? R_SOCKS : R_TROUSERS;
  }

  // Upper legs & hips -> trousers.
  if (/UpLeg$/.test(name) || /Hips$/.test(name)) return R_TROUSERS;

  // Right hand (incl. fingers) -> glove.
  if (/RightHand/.test(name)) return R_GLOVE;

  // Torso/arms/neck -> jacket, with a narrow white shirt wedge on the front chest.
  if (/Spine|Shoulder|Arm|ForeArm|Neck/.test(name)) {
    const frontEnough = (z * frontSign) > (shirtZThresh * frontSign);
    if (/Spine1|Spine2/.test(name) && frontEnough && Math.abs(x) < shirtHalfWidth) {
      return R_SHIRT;
    }
    return R_JACKET;
  }

  // Head, left hand, everything else -> skin (keep diffuse).
  return R_SKIN;
}

function voteRegion(a, b, c) {
  if (a === b) return a;      // a,b agree (covers a==b==c too)
  if (a === c || b === c) return c; // c agrees with one of a/b
  // all three distinct -> highest priority wins
  let best = a;
  if (PRIORITY[b] > PRIORITY[best]) best = b;
  if (PRIORITY[c] > PRIORITY[best]) best = c;
  return best;
}

function averageBoneY(boneNames, boneBindPos, patterns, fallback) {
  let sum = 0, n = 0;
  for (const re of patterns) {
    const i = boneNames.findIndex((nm) => re.test(nm));
    if (i >= 0) { sum += boneBindPos[i].y; n++; }
  }
  return n > 0 ? sum / n : fallback;
}

function boneZ(boneNames, boneBindPos, re) {
  const i = boneNames.findIndex((nm) => re.test(nm));
  return i >= 0 ? boneBindPos[i].z : NaN;
}

// ---------------------------------------------------------------------------
// Procedural 64x64 white-noise roughness map -> sequin sparkle under the spot.
// ---------------------------------------------------------------------------
function makeSparkleTexture() {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    // Bimodal-ish noise: mostly rough with scattered smooth (glinty) specks.
    const r = Math.random();
    const v = r < 0.12 ? (20 + Math.random() * 40) : (140 + Math.random() * 90);
    const o = i * 4;
    data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Fedora: crown (tapered cylinder, pinched top) + brim (lathe) + band.
// Parented to the Head bone; Mixamo cm-scale compensated via getWorldScale.
// ---------------------------------------------------------------------------
function attachFedora(root) {
  // GLTFLoader strips ':' -> bone reads as 'mixamorigHead'. Match by suffix,
  // excluding 'HeadTop_End'.
  let headBone = root.getObjectByName('mixamorig:Head') || root.getObjectByName('mixamorigHead');
  if (!headBone) {
    root.traverse((o) => { if (!headBone && o.isBone && /Head$/.test(o.name)) headBone = o; });
  }
  if (!headBone) {
    console.info('[Costume] Head bone not found — no fedora');
    return;
  }

  const black = new THREE.MeshStandardMaterial({ color: 0x080808, metalness: 0.1, roughness: 0.5 });
  const hat = new THREE.Group();
  hat.name = 'mj_fedora';

  // Crown — tapered cylinder, radialSegments 24 (~200 tris), slightly pinched top.
  const crownH = 0.11;
  const crown = new THREE.Mesh(
    new THREE.CylinderGeometry(0.084, 0.098, crownH, 24, 1, true), black,
  );
  crown.position.y = crownH / 2;
  hat.add(crown);

  // Pinched, closed top cap (cone-ish, small).
  const top = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.084, 0.03, 24, 1, false), black,
  );
  top.position.y = crownH + 0.014;
  hat.add(top);

  // Brim — flat ring via lathe-like RingGeometry, tilted slightly.
  const brim = new THREE.Mesh(
    new THREE.RingGeometry(0.09, 0.155, 32), black,
  );
  brim.rotation.x = -Math.PI / 2;
  brim.material = new THREE.MeshStandardMaterial({ color: 0x080808, metalness: 0.1, roughness: 0.5, side: THREE.DoubleSide });
  hat.add(brim);

  // Band — thin torus around the crown base.
  const band = new THREE.Mesh(
    new THREE.TorusGeometry(0.092, 0.008, 8, 24),
    new THREE.MeshStandardMaterial({ color: 0x141414, metalness: 0.2, roughness: 0.55 }),
  );
  band.rotation.x = Math.PI / 2;
  band.position.y = 0.02;
  hat.add(band);

  hat.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });

  // Compensate Mixamo armature world-scale so the hat is sized in real meters.
  const s = new THREE.Vector3();
  headBone.getWorldScale(s);
  const inv = (s.y && isFinite(s.y) && s.y !== 0) ? (1 / s.y) : 1;
  hat.scale.setScalar(inv);

  // Sit on the crown of the head: up along the (compensated) head-local +Y,
  // slight forward tilt (~6 deg). Head-local axes carry the armature scale, so
  // the local offset is also expressed in compensated units.
  hat.position.set(0, 0.11 * inv, 0.01 * inv);
  hat.rotation.x = -0.105; // ~6 deg forward tilt

  headBone.add(hat);
}
