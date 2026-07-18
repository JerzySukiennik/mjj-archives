// Lighting.js — signature Motown 25 look: ONE dramatic front-of-house spotlight
// on the performer + very dim cool fill so the dark house reads but stays moody.
// Exactly ONE shadow-casting light. Fog adds depth falloff.
//
// export function createLighting(scene, stageAnchor, opts = {}) -> { dispose }

import * as THREE from 'three';

export function createLighting(scene, stageAnchor, opts = {}) {
  const {
    spotColor = 0xfff2d6,     // warm white
    spotIntensity = 130,      // physically-ish; tuned for MeshStandardMaterial (raised for performer visibility)
    fill = true,
    fog = true,
  } = opts;

  const added = [];
  const disposables = [];

  const target = stageAnchor || new THREE.Object3D();
  const aim = target.position.clone();

  // ---- The dramatic spotlight (front-of-house, above audience) -----------
  const spot = new THREE.SpotLight(spotColor, spotIntensity);
  spot.position.set(aim.x + 0.5, aim.y + 12, aim.z + 12); // FOH, high, in front
  spot.angle = Math.PI / 9;          // ~20° tight-ish cone
  spot.penumbra = 0.45;              // soft edge
  spot.decay = 1.4;
  spot.distance = 45;
  spot.castShadow = true;            // the ONLY shadow-caster
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.camera.near = 2;
  spot.shadow.camera.far = 42;
  spot.shadow.camera.fov = 30;
  spot.shadow.bias = -0.0006;        // tuned to kill acne without peter-panning
  spot.shadow.normalBias = 0.02;

  const spotTarget = new THREE.Object3D();
  spotTarget.position.copy(aim);
  scene.add(spotTarget);
  spot.target = spotTarget;
  scene.add(spot);
  added.push(spot, spotTarget);

  // ---- Very dim cool hemisphere fill (house reads dark-but-visible) ------
  const hemi = new THREE.HemisphereLight(0x3a4a6a, 0x120a06, 0.14);
  scene.add(hemi);
  added.push(hemi);

  // ---- Faint warm fill on the proscenium so the arch isn't pure black ----
  let performerFill = null;
  if (fill) {
    const proscFill = new THREE.PointLight(0xa8703a, 8, 30, 2.0);
    proscFill.position.set(0, aim.y + 9, aim.z - 2);
    proscFill.castShadow = false;
    scene.add(proscFill);
    added.push(proscFill);

    // Dedicated warm fill ON THE PERFORMER so MJ reads clearly under the single
    // spot — tight distance so it doesn't spill into the dark house.
    performerFill = new THREE.PointLight(0xffe2b8, 10, 18, 1.8);
    performerFill.position.set(aim.x, aim.y + 4, aim.z + 7);
    performerFill.castShadow = false;
    scene.add(performerFill);
    added.push(performerFill);

    // Cool back/rim to separate performer from back curtain (boosted for silhouette).
    const rim = new THREE.DirectionalLight(0x445577, 0.55);
    rim.position.set(0, aim.y + 8, aim.z - 10);
    rim.castShadow = false;
    scene.add(rim);
    added.push(rim);
  }

  // ---- Two broad stage washes for the 'full-stage' preset (off by default) --
  // Wide, soft, non-shadow-casting fills aimed left/right of the performer.
  const washL = new THREE.SpotLight(0xfff2d6, 0);
  washL.position.set(aim.x - 8, aim.y + 10, aim.z + 8);
  washL.angle = Math.PI / 4;
  washL.penumbra = 0.9;
  washL.decay = 1.2;
  washL.distance = 55;
  washL.castShadow = false;
  const washLTarget = new THREE.Object3D();
  washLTarget.position.set(aim.x - 3, aim.y, aim.z);
  scene.add(washLTarget);
  washL.target = washLTarget;
  scene.add(washL);
  added.push(washL, washLTarget);

  const washR = new THREE.SpotLight(0xfff2d6, 0);
  washR.position.set(aim.x + 8, aim.y + 10, aim.z + 8);
  washR.angle = Math.PI / 4;
  washR.penumbra = 0.9;
  washR.decay = 1.2;
  washR.distance = 55;
  washR.castShadow = false;
  const washRTarget = new THREE.Object3D();
  washRTarget.position.set(aim.x + 3, aim.y, aim.z);
  scene.add(washRTarget);
  washR.target = washRTarget;
  scene.add(washR);
  added.push(washR, washRTarget);

  // Capture the exact 'single-spot' defaults so applyPreset can restore them.
  const proscFillRef = fill ? added.find((o) => o instanceof THREE.PointLight) : null;
  const rimRef = fill ? added.find((o) => o instanceof THREE.DirectionalLight) : null;
  const defaults = {
    spotIntensity: spot.intensity,
    spotAngle: spot.angle,
    hemi: hemi.intensity,
    prosc: proscFillRef ? proscFillRef.intensity : 0,
    perf: performerFill ? performerFill.intensity : 0,
    rim: rimRef ? rimRef.intensity : 0,
  };

  /**
   * Switch lighting preset by mutating intensities/angles only (no scene
   * rebuild, no fog change). Cheap enough to call at any time.
   * @param {'single-spot'|'full-stage'|'blackout'} name
   */
  function applyPreset(name) {
    switch (name) {
      case 'single-spot':
        spot.intensity = defaults.spotIntensity;
        spot.angle = defaults.spotAngle;
        hemi.intensity = defaults.hemi;
        if (proscFillRef) proscFillRef.intensity = defaults.prosc;
        if (performerFill) performerFill.intensity = defaults.perf;
        if (rimRef) rimRef.intensity = defaults.rim;
        washL.intensity = 0;
        washR.intensity = 0;
        break;
      case 'full-stage':
        spot.intensity = 55;
        spot.angle = Math.PI / 6;
        hemi.intensity = 0.6;
        if (proscFillRef) proscFillRef.intensity = 14;
        if (performerFill) performerFill.intensity = 6; // modest under the wide wash
        if (rimRef) rimRef.intensity = 0.6;
        washL.intensity = 35;
        washR.intensity = 35;
        break;
      case 'blackout':
        spot.intensity = 0;
        hemi.intensity = 0.02;
        if (proscFillRef) proscFillRef.intensity = 0;
        if (performerFill) performerFill.intensity = 0;
        if (rimRef) rimRef.intensity = 0;
        washL.intensity = 0;
        washR.intensity = 0;
        break;
      default:
        console.warn('[Lighting] unknown preset:', name);
    }
  }

  // ---- Fog for depth falloff into darkness -------------------------------
  let prevFog = null;
  if (fog) {
    prevFog = scene.fog;
    scene.fog = new THREE.FogExp2(0x05040a, 0.016);
  }

  /**
   * Resize the (single) shadow map for the quality-preset system. Disposes the
   * existing GPU map so three.js re-allocates it at the new resolution.
   * @param {number} px - square shadow map edge (512 / 1024 / 2048).
   */
  function setShadowMapSize(px) {
    spot.shadow.mapSize.set(px, px);
    if (spot.shadow.map) {
      spot.shadow.map.dispose();
      spot.shadow.map = null;
    }
  }

  function dispose() {
    for (const o of added) {
      scene.remove(o);
      if (o.shadow && o.shadow.map) o.shadow.map.dispose();
      o.dispose?.();
    }
    for (const d of disposables) d.dispose?.();
    if (fog) scene.fog = prevFog;
  }

  return { dispose, spot, applyPreset, setShadowMapSize };
}
