// Hall.js — procedural Pasadena Civic Auditorium evocation (Motown 25, 1983).
// Dark art-deco theater: proscenium arch, reflective stage floor, band risers,
// side legs/curtains, back wall, raked empty audience (InstancedMesh), deco trim.
// Everything procedural — NO external textures/models, NO network fetches.
// Budget: well under ~150k triangles, minimal draw calls (instanced/merged).
//
// export function createHall(scene, opts = {}) -> { stageAnchor, dispose }

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---- small helpers ---------------------------------------------------------

const _disposables = new Set();
function track(obj) { _disposables.add(obj); return obj; }

// Tiny procedural equirect environment gradient (warm hot-spot fading to near
// black). Used ONLY as a per-material envMap for the glossy stage floor — never
// assigned to scene.environment (that would leak onto every material).
function makeStageEnvTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 32;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0.0, '#1a120a');
  grad.addColorStop(0.28, '#8a6636');  // warm spot-glow hot spot near top centre
  grad.addColorStop(0.5, '#241a10');
  grad.addColorStop(1.0, '#050303');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, c.width, c.height);
  // brighten a soft central hot spot
  const rg = ctx.createRadialGradient(c.width / 2, c.height * 0.28, 2, c.width / 2, c.height * 0.28, 18);
  rg.addColorStop(0, 'rgba(255,220,150,0.6)');
  rg.addColorStop(1, 'rgba(255,220,150,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return track(tex);
}

// Vertical-gradient darkened velvet noise (darker at top/bottom folds) for curtains.
function makeCurtainTexture(base = [40, 8, 12], amp = 10, size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    // darken toward top (0) and bottom (1) of the drop
    const t = y / (size - 1);
    const shade = 0.55 + 0.45 * Math.sin(Math.PI * t); // 0.55 at edges -> 1.0 mid
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const n = (Math.random() - 0.5) * 2 * amp;
      img.data[i] = Math.max(0, Math.min(255, (base[0] + n) * shade));
      img.data[i + 1] = Math.max(0, Math.min(255, (base[1] + n) * shade));
      img.data[i + 2] = Math.max(0, Math.min(255, (base[2] + n) * shade));
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return track(tex);
}

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
  const stageEnvTex = makeStageEnvTexture();
  const stageFloorMat = track(new THREE.MeshStandardMaterial({
    color: 0x3a2a1c, map: floorTex, roughness: 0.18, metalness: 0.25,
    envMap: stageEnvTex, envMapIntensity: 0.42,
  }));

  const decoTex = makeDecoTexture();
  const brassMat = track(new THREE.MeshStandardMaterial({
    color: 0x8a6a2a, roughness: 0.35, metalness: 0.85,
  }));
  const brassTrimMat = track(new THREE.MeshStandardMaterial({
    color: 0xb9924a, roughness: 0.3, metalness: 0.9,
  }));
  const curtainTex = makeCurtainTexture([40, 8, 12], 10, 128);
  curtainTex.repeat.set(2, 4);
  const curtainMat = track(new THREE.MeshStandardMaterial({
    color: 0x4a0d12, map: curtainTex, roughness: 0.95, metalness: 0.0,
  }));
  const wallMat = track(new THREE.MeshStandardMaterial({
    color: 0x1a140f, roughness: 0.9, metalness: 0.05,
    map: (() => { const t = makeNoiseTexture([26, 20, 14], 8, 128); t.repeat.set(8, 3); return t; })(),
  }));
  // Warmer side-wall variant + wainscot band material.
  const sideWallMat = track(new THREE.MeshStandardMaterial({
    color: 0x241a12, roughness: 0.9, metalness: 0.05,
    map: (() => { const t = makeNoiseTexture([34, 24, 16], 8, 128); t.repeat.set(8, 3); return t; })(),
  }));
  const wainscotMat = track(new THREE.MeshStandardMaterial({
    color: 0x3a2412, roughness: 0.7, metalness: 0.1,
  }));
  // Dark low-poly material for band-riser instrument silhouettes.
  const instrumentMat = track(new THREE.MeshStandardMaterial({
    color: 0x0d0b09, roughness: 0.7, metalness: 0.15,
  }));
  // Emissive-only red EXIT plaque material + faint halo.
  const exitMat = track(new THREE.MeshStandardMaterial({
    color: 0x000000, emissive: 0xff2a1a, emissiveIntensity: 1.8, roughness: 1.0,
  }));
  const exitHaloMat = track(new THREE.MeshBasicMaterial({
    color: 0xff2a1a, transparent: true, opacity: 0.15, depthWrite: false,
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
    const steps = 4;
    for (let s = 0; s < steps; s++) {
      const t = jambT * (1 - s * 0.18);
      const m = new THREE.Mesh(
        g(new THREE.BoxGeometry(t, PROSC_H + 1.2, 1.2 - s * 0.22)),
        s === steps - 1 ? brassMat : (s === 1 ? decoWallMat() : wallMat)
      );
      const inward = (PROSC_W / 2 + jambT / 2) - s * 0.34;
      m.position.set(Math.sign(x) * inward, STAGE_H + (PROSC_H + 1.2) / 2 - 0.6, 0.6 + s * 0.12);
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

  // Proscenium header (top beam) with stepped deco (4 steps).
  for (let s = 0; s < 4; s++) {
    const w = PROSC_W + jambT * 2 - s * 0.68;
    const beam = new THREE.Mesh(
      g(new THREE.BoxGeometry(w, 1.4 - s * 0.16, 1.2 - s * 0.22)),
      s === 3 ? brassMat : (s === 1 ? decoWallMat() : wallMat)
    );
    beam.position.y = topY + 0.4 - s * 0.42;
    beam.position.z = 0.6 + s * 0.12;
    beam.castShadow = true;
    prosc.add(beam);
  }

  // ---- Deco trim: sunburst fan, corner medallions, crown molding ----------
  // All small brass trim merged into ONE mesh (castShadow=false) to save calls.
  {
    const trimParts = [];
    const push = (geo, m) => {
      geo.applyMatrix4(m);
      trimParts.push(geo);
    };
    const M = new THREE.Matrix4();
    const T = new THREE.Matrix4();
    const R = new THREE.Matrix4();
    const S = new THREE.Matrix4();

    // Sunburst / fan over the header: thin radiating boxes from a centre point.
    const fanCx = 0, fanCy = topY + 1.0, fanCz = 0.5;
    const rays = 13;
    for (let i = 0; i < rays; i++) {
      const a = (-Math.PI / 2) + (i - (rays - 1) / 2) * (Math.PI / (rays + 2));
      const len = 2.6;
      const ray = new THREE.BoxGeometry(0.09, len, 0.09);
      // move so base sits at fan centre, then rotate about Z, then translate to centre
      R.makeRotationZ(a);
      T.makeTranslation(0, len / 2, 0);
      M.copy(R).multiply(T);
      M.premultiply(new THREE.Matrix4().makeTranslation(fanCx, fanCy, fanCz));
      push(ray, M);
    }
    // Fan hub ring.
    {
      const hub = new THREE.CylinderGeometry(0.35, 0.35, 0.12, 20);
      M.makeRotationX(Math.PI / 2);
      M.premultiply(new THREE.Matrix4().makeTranslation(fanCx, fanCy, fanCz));
      push(hub, M);
    }
    // Corner medallions: small stepped box stacks where jambs meet the header.
    for (const sx of [-1, 1]) {
      const mx = sx * (PROSC_W / 2 + 0.2);
      const my = topY - 0.2;
      for (let k = 0; k < 3; k++) {
        const sz = 0.7 - k * 0.18;
        const box = new THREE.BoxGeometry(sz, sz, 0.25);
        M.makeTranslation(mx, my, 0.62 + k * 0.06);
        push(box, M);
      }
    }
    // Thin brass crown molding line across the header top.
    {
      const crown = new THREE.BoxGeometry(PROSC_W + jambT * 2 + 0.6, 0.14, 0.14);
      M.makeTranslation(0, topY + 1.05, 0.7);
      push(crown, M);
    }

    const mergedTrim = mergeGeometries(trimParts, false);
    trimParts.forEach((p) => p.dispose());
    if (mergedTrim) {
      g(mergedTrim);
      const trimMesh = new THREE.Mesh(mergedTrim, brassTrimMat);
      trimMesh.castShadow = false;
      trimMesh.receiveShadow = false;
      prosc.add(trimMesh);
    }
  }
  group.add(prosc);

  // ---- Side legs / curtains (velvet) -------------------------------------
  function curtainLeg(x) {
    // Pleated look: half-cylinder columns (front-facing) merged into ONE geometry.
    const pleats = 9;
    const pleatR = 0.28;
    const step = 0.44;
    const parts = [];
    const M = new THREE.Matrix4();
    for (let i = 0; i < pleats; i++) {
      // half cylinder, open toward +z (theta start at PI/2, length PI)
      const cyl = new THREE.CylinderGeometry(
        pleatR, pleatR, PROSC_H, 8, 1, true, Math.PI / 2, Math.PI
      );
      M.makeTranslation(i * step, STAGE_H + PROSC_H / 2, -0.35 - (i % 2) * 0.06);
      cyl.applyMatrix4(M);
      parts.push(cyl);
    }
    const merged = mergeGeometries(parts, false);
    parts.forEach((p) => p.dispose());
    g(merged);
    const legMesh = new THREE.Mesh(merged, curtainMat);
    legMesh.castShadow = true;
    legMesh.position.set(x, 0, 0.2);
    if (x > 0) legMesh.scale.x = -1;
    group.add(legMesh);
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

  // Scalloped valance bottom edge: row of small half-cylinders merged into one.
  {
    const scallops = 22;
    const sR = 0.42;
    const span = PROSC_W;
    const parts = [];
    const M = new THREE.Matrix4();
    const R = new THREE.Matrix4();
    for (let i = 0; i < scallops; i++) {
      const sx = -span / 2 + (i + 0.5) * (span / scallops);
      const half = new THREE.CylinderGeometry(sR, sR, 0.5, 8, 1, false, 0, Math.PI);
      R.makeRotationZ(Math.PI); // hump pointing down
      M.makeTranslation(sx, STAGE_H + PROSC_H - 2.2, -0.2);
      M.multiply(R);
      // rotate cylinder axis to lie along z so the half-round faces the house
      const Rx = new THREE.Matrix4().makeRotationX(Math.PI / 2);
      half.applyMatrix4(Rx);
      half.applyMatrix4(M);
      parts.push(half);
    }
    const merged = mergeGeometries(parts, false);
    parts.forEach((p) => p.dispose());
    g(merged);
    const scallopMesh = new THREE.Mesh(merged, curtainMat);
    scallopMesh.castShadow = false;
    group.add(scallopMesh);
  }

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

  // Wainscot band on the back wall (house side, behind audience gaze is fine).
  const backWainscot = new THREE.Mesh(g(new THREE.BoxGeometry(46, 0.4, 0.12)), wainscotMat);
  backWainscot.position.set(0, 1.2, 35.6);
  group.add(backWainscot);

  // Side walls with deco pilasters + warmer tint + wainscot band.
  function sideWall(x) {
    const wall = new THREE.Mesh(g(new THREE.PlaneGeometry(44, 18)), sideWallMat);
    wall.position.set(x, 8, 14);
    wall.rotation.y = x > 0 ? -Math.PI / 2 : Math.PI / 2;
    group.add(wall);
    // wainscot band at ~1.2m running along the wall (long axis is z here)
    const wainscot = new THREE.Mesh(g(new THREE.BoxGeometry(0.12, 0.4, 44)), wainscotMat);
    wainscot.position.set(x + (x > 0 ? -0.15 : 0.15), 1.2, 14);
    group.add(wainscot);
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

  // ---- Exit-sign red glows in the house (emissive only, read through fog) --
  {
    const exitGeo = g(new THREE.PlaneGeometry(0.6, 0.25));
    const haloGeo = g(new THREE.PlaneGeometry(1.0, 0.5));
    const placeExit = (x, y, z, ry) => {
      const plq = new THREE.Mesh(exitGeo, exitMat);
      plq.position.set(x, y, z);
      plq.rotation.y = ry;
      group.add(plq);
      const halo = new THREE.Mesh(haloGeo, exitHaloMat);
      halo.position.set(x, y, z);
      halo.rotation.y = ry;
      // nudge halo slightly toward house so it sits behind the plaque face
      halo.position.x += Math.sin(ry) * 0.02;
      halo.position.z += Math.cos(ry) * 0.02 * -1;
      group.add(halo);
    };
    // two on each side wall near the back, two on the back wall
    placeExit(-22.6, 3.0, 26, Math.PI / 2);
    placeExit(-22.6, 3.0, 12, Math.PI / 2);
    placeExit(22.6, 3.0, 26, -Math.PI / 2);
    placeExit(22.6, 3.0, 12, -Math.PI / 2);
    placeExit(-9, 3.0, 35.4, Math.PI);
    placeExit(9, 3.0, 35.4, Math.PI);
  }

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

  // ---- Band-riser instrument silhouettes (low-poly, dark, merged) ---------
  {
    const r1Top = STAGE_H + 0.6, r1Z = -STAGE_D + 3.0;   // 1.8, -9
    const r2Top = STAGE_H + 1.2, r2Z = -STAGE_D + 1.2;   // 2.4, -10.8
    const parts = [];
    const M = new THREE.Matrix4();
    const addCyl = (rt, rb, h, seg, x, y, z, rx = 0, rz = 0) => {
      const geo = new THREE.CylinderGeometry(rt, rb, h, seg);
      if (rx || rz) {
        const R = new THREE.Matrix4();
        if (rx) R.makeRotationX(rx);
        if (rz) R.multiply(new THREE.Matrix4().makeRotationZ(rz));
        geo.applyMatrix4(R);
      }
      geo.applyMatrix4(M.makeTranslation(x, y, z));
      parts.push(geo);
    };
    const addBox = (w, h, d, x, y, z) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      geo.applyMatrix4(M.makeTranslation(x, y, z));
      parts.push(geo);
    };

    // Drum kit (centre, on riser 2)
    const dcx = 0, dcz = r2Z + 0.1, dy = r2Top;
    addCyl(0.45, 0.45, 0.55, 12, dcx, dy + 0.28, dcz);                 // kick
    addCyl(0.28, 0.28, 0.24, 12, dcx - 0.5, dy + 0.9, dcz - 0.1);      // tom L
    addCyl(0.28, 0.28, 0.24, 12, dcx + 0.5, dy + 0.9, dcz - 0.1);      // tom R
    addCyl(0.34, 0.34, 0.2, 12, dcx, dy + 0.75, dcz + 0.45);           // snare
    // hi-hat + cymbals (thin cylinders on thin poles)
    addCyl(0.02, 0.02, 1.0, 8, dcx - 1.0, dy + 0.5, dcz);              // pole
    addCyl(0.3, 0.3, 0.03, 12, dcx - 1.0, dy + 1.05, dcz);            // hi-hat
    addCyl(0.02, 0.02, 1.3, 8, dcx + 1.0, dy + 0.65, dcz - 0.2);      // pole
    addCyl(0.36, 0.36, 0.03, 12, dcx + 1.0, dy + 1.35, dcz - 0.2, 0.15); // crash
    addCyl(0.02, 0.02, 1.4, 8, dcx + 0.2, dy + 0.7, dcz - 0.5);       // pole
    addCyl(0.4, 0.4, 0.03, 12, dcx + 0.2, dy + 1.45, dcz - 0.5, 0.1);  // ride

    // 2 keyboard stands (slab on X-legs) on riser 1
    for (const kx of [-4.5, 4.5]) {
      const kz = r1Z + 0.2, ky = r1Top;
      addBox(1.8, 0.12, 0.5, kx, ky + 0.85, kz);                      // slab
      addBox(0.06, 0.9, 0.06, kx - 0.7, ky + 0.45, kz + 0.15);        // leg
      addBox(0.06, 0.9, 0.06, kx + 0.7, ky + 0.45, kz - 0.15);        // leg
      addBox(0.06, 0.9, 0.06, kx - 0.7, ky + 0.45, kz - 0.15);
      addBox(0.06, 0.9, 0.06, kx + 0.7, ky + 0.45, kz + 0.15);
    }

    // 3 mic stands (thin cylinder + small ball) downstage of risers
    for (const mx of [-2.2, 0.4, 2.6]) {
      const mz = r1Z + 1.6, my = r1Top;
      addCyl(0.03, 0.03, 1.5, 8, mx, my + 0.75, mz);
      const ball = new THREE.SphereGeometry(0.07, 8, 6);
      ball.applyMatrix4(M.makeTranslation(mx, my + 1.5, mz));
      parts.push(ball);
    }

    const merged = mergeGeometries(parts, false);
    parts.forEach((p) => p.dispose());
    g(merged);
    const instruments = new THREE.Mesh(merged, instrumentMat);
    instruments.castShadow = false;
    instruments.receiveShadow = true;
    group.add(instruments);
  }

  // ---- Aisle carpet runners ----------------------------------------------
  for (const cx of [-8, 0, 8]) {
    const carpet = new THREE.Mesh(g(new THREE.PlaneGeometry(1.6, 34)), carpetMat);
    carpet.rotation.x = -Math.PI / 2;
    carpet.position.set(cx, 0.01, 18);
    group.add(carpet);
  }

  // ---- Empty audience — raked rows via InstancedMesh ---------------------
  // Two instanced parts (seat cushion + seat back) => 2 instanced draw calls total.
  const ROWS = opts.seatRows ?? 16;   // build-time quality knob (low=10, med/high=16)
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
