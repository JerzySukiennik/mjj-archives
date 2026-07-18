// Hall.js — procedural Pasadena Civic Auditorium evocation (Motown 25, 1983).
// Dark art-deco theater: proscenium arch, reflective stage floor, band risers,
// side legs/curtains, back wall, raked empty audience (InstancedMesh), deco trim.
// Everything procedural — NO external textures/models, NO network fetches.
// Budget: well under ~150k triangles, minimal draw calls (instanced/merged).
//
// export function createHall(scene, opts = {}) -> { stageAnchor, dispose }

import * as THREE from 'three';

// ---- small helpers ---------------------------------------------------------

const _disposables = new Set();
function track(obj) { _disposables.add(obj); return obj; }

// Procedural vertical art-deco panel texture (brass pilaster fluting / wall relief).
function makeDecoTexture(base = '#241c14', line = '#3a2c1c', stripes = 10) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = line;
  ctx.lineWidth = 2;
  for (let i = 1; i < stripes; i++) {
    const x = (i / stripes) * c.width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, c.height);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return track(tex);
}

// Subtle mottled velvet/plaster texture for large surfaces.
function makeNoiseTexture(base = [30, 22, 16], amp = 14, size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 2 * amp;
    img.data[i] = Math.max(0, Math.min(255, base[0] + n));
    img.data[i + 1] = Math.max(0, Math.min(255, base[1] + n));
    img.data[i + 2] = Math.max(0, Math.min(255, base[2] + n));
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return track(tex);
}

// ---------------------------------------------------------------------------

export function createHall(scene, opts = {}) {
  const group = new THREE.Group();
  group.name = 'Hall';
  scene.add(group);

  // Stage geometry constants (metres). Stage front at z=0, upstage toward -z.
  const STAGE_W = 18;      // stage width
  const STAGE_D = 12;      // stage depth
  const STAGE_H = 1.2;     // stage riser height above house floor
  const PROSC_W = 20;      // proscenium opening width
  const PROSC_H = 11;      // proscenium opening height

  // ---- Materials ---------------------------------------------------------
  const floorTex = makeNoiseTexture([26, 18, 12], 8, 128);
  floorTex.repeat.set(6, 4);
  const stageFloorMat = track(new THREE.MeshStandardMaterial({
    color: 0x3a2a1c, map: floorTex, roughness: 0.28, metalness: 0.1,
  }));

  const decoTex = makeDecoTexture();
  const brassMat = track(new THREE.MeshStandardMaterial({
    color: 0x8a6a2a, roughness: 0.35, metalness: 0.85,
  }));
  const brassTrimMat = track(new THREE.MeshStandardMaterial({
    color: 0xb9924a, roughness: 0.3, metalness: 0.9,
  }));
  const curtainTex = makeNoiseTexture([40, 8, 12], 10, 128);
  curtainTex.repeat.set(2, 4);
  const curtainMat = track(new THREE.MeshStandardMaterial({
    color: 0x4a0d12, map: curtainTex, roughness: 0.95, metalness: 0.0,
  }));
  const wallMat = track(new THREE.MeshStandardMaterial({
    color: 0x1a140f, roughness: 0.9, metalness: 0.05,
    map: (() => { const t = makeNoiseTexture([26, 20, 14], 8, 128); t.repeat.set(8, 3); return t; })(),
  }));
  const houseFloorMat = track(new THREE.MeshStandardMaterial({
    color: 0x120d0a, roughness: 0.95, metalness: 0.0,
  }));
  const carpetMat = track(new THREE.MeshStandardMaterial({
    color: 0x5a1414, roughness: 1.0, metalness: 0.0,
  }));
  const riserMat = track(new THREE.MeshStandardMaterial({
    color: 0x241a12, roughness: 0.8, metalness: 0.05,
  }));
  const seatMat = track(new THREE.MeshStandardMaterial({
    color: 0x3a1414, roughness: 0.85, metalness: 0.05,
  }));
  const seatMetalMat = track(new THREE.MeshStandardMaterial({
    color: 0x1c1c20, roughness: 0.5, metalness: 0.6,
  }));

  const geoms = new Set();
  const g = (geo) => { geoms.add(geo); return geo; };

  // ---- Stage floor (raised, reflective) ----------------------------------
  const stageFloor = new THREE.Mesh(
    g(new THREE.BoxGeometry(STAGE_W, STAGE_H, STAGE_D)),
    stageFloorMat
  );
  stageFloor.position.set(0, STAGE_H / 2, -STAGE_D / 2);
  stageFloor.receiveShadow = true;
  group.add(stageFloor);

  // Deco lip along the stage front edge.
  const lip = new THREE.Mesh(g(new THREE.BoxGeometry(STAGE_W, 0.18, 0.35)), brassTrimMat);
  lip.position.set(0, STAGE_H - 0.02, 0.1);
  group.add(lip);

  // ---- House floor (audience raked base) ---------------------------------
  const houseFloor = new THREE.Mesh(g(new THREE.PlaneGeometry(46, 40)), houseFloorMat);
  houseFloor.rotation.x = -Math.PI / 2;
  houseFloor.position.set(0, 0, 16);
  houseFloor.receiveShadow = true;
  group.add(houseFloor);

  // ---- Proscenium arch (stepped deco silhouette) -------------------------
  // Built from box segments framing the opening; stepped moulding on the inner edge.
  const prosc = new THREE.Group();
  const jambT = 1.6; // jamb thickness
  const topY = STAGE_H + PROSC_H;

  function jamb(x) {
    const steps = 3;
    for (let s = 0; s < steps; s++) {
      const t = jambT * (1 - s * 0.22);
      const m = new THREE.Mesh(
        g(new THREE.BoxGeometry(t, PROSC_H + 1.2, 1.2 - s * 0.3)),
        s === steps - 1 ? brassMat : (s === 1 ? decoWallMat() : wallMat)
      );
      const inward = (PROSC_W / 2 + jambT / 2) - s * 0.42;
      m.position.set(Math.sign(x) * inward, STAGE_H + (PROSC_H + 1.2) / 2 - 0.6, 0.6 + s * 0.15);
      m.castShadow = true;
      prosc.add(m);
    }
  }
  // memoized deco wall material (uses decoTex)
  let _decoWallMat;
  function decoWallMat() {
    if (!_decoWallMat) {
      const t = decoTex.clone();
      t.needsUpdate = true;
      t.repeat.set(1, 6);
      _decoWallMat = track(new THREE.MeshStandardMaterial({
        color: 0x6a4e24, map: t, roughness: 0.5, metalness: 0.6,
      }));
    }
    return _decoWallMat;
  }
  jamb(-1);
  jamb(1);

  // Proscenium header (top beam) with stepped deco.
  for (let s = 0; s < 3; s++) {
    const w = PROSC_W + jambT * 2 - s * 0.84;
    const beam = new THREE.Mesh(
      g(new THREE.BoxGeometry(w, 1.4 - s * 0.2, 1.2 - s * 0.3)),
      s === 2 ? brassMat : (s === 1 ? decoWallMat() : wallMat)
    );
    beam.position.set(0, topY - 0.6 - s * 0.45 * 0, topY * 0 + 0.6 + s * 0.15);
    beam.position.y = topY + 0.4 - s * 0.5;
    beam.castShadow = true;
    prosc.add(beam);
  }
  group.add(prosc);

  // ---- Side legs / curtains (velvet) -------------------------------------
  function curtainLeg(x) {
    const legGroup = new THREE.Group();
    // pleated look via a few overlapping vertical boxes
    const pleats = 5;
    for (let i = 0; i < pleats; i++) {
      const w = 1.2;
      const m = new THREE.Mesh(
        g(new THREE.BoxGeometry(w, PROSC_H, 0.4)),
        curtainMat
      );
      m.position.set(i * (w * 0.7), STAGE_H + PROSC_H / 2, -0.4 - (i % 2) * 0.25);
      m.castShadow = true;
      legGroup.add(m);
    }
    legGroup.position.set(x, 0, 0.2);
    if (x > 0) legGroup.scale.x = -1;
    group.add(legGroup);
  }
  curtainLeg(-(PROSC_W / 2 - 0.4));
  curtainLeg(PROSC_W / 2 - 0.4);

  // Top valance / border curtain.
  const valance = new THREE.Mesh(
    g(new THREE.BoxGeometry(PROSC_W, 2.4, 0.5)),
    curtainMat
  );
  valance.position.set(0, STAGE_H + PROSC_H - 1.0, -0.2);
  valance.castShadow = true;
  group.add(valance);

  // ---- Back wall + upstage back curtain ----------------------------------
  const backCurtain = new THREE.Mesh(
    g(new THREE.PlaneGeometry(STAGE_W + 2, PROSC_H + 2)),
    curtainMat
  );
  backCurtain.position.set(0, STAGE_H + (PROSC_H) / 2, -STAGE_D + 0.1);
  backCurtain.receiveShadow = true;
  group.add(backCurtain);

  const backWall = new THREE.Mesh(g(new THREE.PlaneGeometry(46, 20)), wallMat);
  backWall.position.set(0, 8, -STAGE_D - 0.5);
  group.add(backWall);

  // Side walls with deco pilasters.
  function sideWall(x) {
    const wall = new THREE.Mesh(g(new THREE.PlaneGeometry(44, 18)), wallMat);
    wall.position.set(x, 8, 14);
    wall.rotation.y = x > 0 ? -Math.PI / 2 : Math.PI / 2;
    group.add(wall);
    // pilasters
    const pilCount = 5;
    for (let i = 0; i < pilCount; i++) {
      const pil = new THREE.Mesh(
        g(new THREE.BoxGeometry(0.6, 12, 0.5)),
        decoWallMat()
      );
      pil.position.set(x + (x > 0 ? -0.3 : 0.3), 6, 2 + i * 8);
      group.add(pil);
    }
  }
  sideWall(-23);
  sideWall(23);

  // ---- Band risers upstage (2 tiers) -------------------------------------
  function riser(tier, z, h) {
    const m = new THREE.Mesh(
      g(new THREE.BoxGeometry(STAGE_W - 3, h, 2.2)),
      riserMat
    );
    m.position.set(0, STAGE_H + h / 2, z);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    // brass front trim
    const trim = new THREE.Mesh(g(new THREE.BoxGeometry(STAGE_W - 3, 0.1, 0.1)), brassTrimMat);
    trim.position.set(0, STAGE_H + h, z + 1.1);
    group.add(trim);
  }
  riser(1, -STAGE_D + 3.0, 0.6);
  riser(2, -STAGE_D + 1.2, 1.2);

  // ---- Aisle carpet runners ----------------------------------------------
  for (const cx of [-8, 0, 8]) {
    const carpet = new THREE.Mesh(g(new THREE.PlaneGeometry(1.6, 34)), carpetMat);
    carpet.rotation.x = -Math.PI / 2;
    carpet.position.set(cx, 0.01, 18);
    group.add(carpet);
  }

  // ---- Empty audience — raked rows via InstancedMesh ---------------------
  // Two instanced parts (seat cushion + seat back) => 2 instanced draw calls total.
  const ROWS = 16;
  const SEATS_PER_ROW = 34;
  const SEAT_GAP_X = 0.62;
  const ROW_GAP_Z = 1.5;
  const RAKE = 0.22;           // vertical rise per row (rake)
  const FRONT_Z = 6.0;         // first row z
  // leave a centre + two aisles empty
  const aisleCols = new Set();

  // count real instances (skip aisle positions)
  let seatCount = 0;
  const placements = [];
  for (let r = 0; r < ROWS; r++) {
    const z = FRONT_Z + r * ROW_GAP_Z;
    const y = r * RAKE;
    for (let s = 0; s < SEATS_PER_ROW; s++) {
      const x = (s - (SEATS_PER_ROW - 1) / 2) * SEAT_GAP_X;
      // carve aisles near cols
      const ax = Math.abs(x);
      if ((ax > 7.4 && ax < 8.6) || ax < 0.45) continue;
      placements.push({ x, y, z });
      seatCount++;
    }
  }

  const cushionGeo = g(new THREE.BoxGeometry(0.5, 0.12, 0.5));
  const backGeo = g(new THREE.BoxGeometry(0.5, 0.6, 0.12));
  const cushions = new THREE.InstancedMesh(cushionGeo, seatMat, seatCount);
  const backs = new THREE.InstancedMesh(backGeo, seatMat, seatCount);
  cushions.castShadow = false; cushions.receiveShadow = true;
  backs.castShadow = false; backs.receiveShadow = true;

  const legsGeo = g(new THREE.BoxGeometry(0.5, 0.4, 0.08));
  const legs = new THREE.InstancedMesh(legsGeo, seatMetalMat, seatCount);

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3(1, 1, 1);
  const pos = new THREE.Vector3();
  placements.forEach((p, i) => {
    // cushion
    pos.set(p.x, p.y + 0.45, p.z);
    m4.compose(pos, q, sc);
    cushions.setMatrixAt(i, m4);
    // back (tilted slightly, behind cushion)
    pos.set(p.x, p.y + 0.75, p.z + 0.28);
    m4.compose(pos, q, sc);
    backs.setMatrixAt(i, m4);
    // front leg/base
    pos.set(p.x, p.y + 0.2, p.z - 0.2);
    m4.compose(pos, q, sc);
    legs.setMatrixAt(i, m4);
  });
  cushions.instanceMatrix.needsUpdate = true;
  backs.instanceMatrix.needsUpdate = true;
  legs.instanceMatrix.needsUpdate = true;
  group.add(cushions, backs, legs);

  // ---- Ceiling (dark, keeps house enclosed) ------------------------------
  const ceiling = new THREE.Mesh(g(new THREE.PlaneGeometry(46, 40)), wallMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, 17, 14);
  group.add(ceiling);

  // ---- Stage anchor: centre-stage floor, where performer stands ----------
  const stageAnchor = new THREE.Object3D();
  stageAnchor.name = 'StageAnchor';
  stageAnchor.position.set(0, STAGE_H, -STAGE_D * 0.42);
  group.add(stageAnchor);

  // ---- dispose -----------------------------------------------------------
  function dispose() {
    group.traverse((o) => {
      if (o.isInstancedMesh) o.dispose?.();
    });
    for (const geo of geoms) geo.dispose();
    for (const d of _disposables) d.dispose?.();
    _disposables.clear();
    scene.remove(group);
  }

  return { stageAnchor, dispose, stageHeight: STAGE_H };
}
