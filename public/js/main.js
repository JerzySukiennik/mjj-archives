// js/main.js — bootstrap + owner of the render loop.
// Loads the manifest, constructs the PlaybackClock, builds the scene (Hall,
// Lighting, Performer from Task B), wires the TransportUI, and drives the
// non-negotiable render loop:
//   const t = clock.currentTime; performer.update(t); renderer.render(...)
// NEVER advance the performer/mixer by deltaTime.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { loadConcert } from './ConcertLoader.js';
import { PlaybackClock } from './PlaybackClock.js';
import { TransportUI } from './TransportUI.js';

const MANIFEST_URL = './concerts/motown25-billiejean/concert.json';

// DOM refs.
const overlay = document.getElementById('loading-overlay');
const overlayInner = overlay.querySelector('.overlay-inner');
const statusEl = document.getElementById('loading-status');
const barEl = document.getElementById('loading-bar');
const hintEl = document.getElementById('loading-hint');
const transportEl = document.getElementById('transport');
const canvasContainer = document.getElementById('canvas-container');

function setStatus(msg) { statusEl.textContent = msg; }
function setProgress(frac) { barEl.style.width = Math.round(Math.min(Math.max(frac, 0), 1) * 100) + '%'; }
function showError(title, detail) {
  overlayInner.classList.add('error');
  overlay.querySelector('.overlay-title').textContent = title;
  statusEl.textContent = detail;
  barEl.style.width = '0%';
  console.error(`[main] ${title}: ${detail}`);
}

async function boot() {
  // 1) Manifest.
  setStatus('Loading manifest…');
  let manifest;
  try {
    manifest = await loadConcert(MANIFEST_URL);
  } catch (err) {
    showError('MANIFEST ERROR', err.message);
    return;
  }
  document.title = `MJJ Archives — ${manifest.name}`;
  setProgress(0.15);

  // 2) Clock (sole owner of <audio>).
  setStatus('Preparing audio…');
  const clock = new PlaybackClock(manifest.audio, { duration: manifest.duration });
  setProgress(0.3);

  // 3) Renderer.
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Intel MBP clamp.
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  canvasContainer.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05040a);

  // 4) Scene build (Task B modules). Fail loudly but keep shell testable.
  setStatus('Building the hall…');
  let hall = null;
  let lighting = null;
  let performer = null;
  let stageAnchor = new THREE.Object3D(); // fallback anchor if Hall isn't present yet.
  scene.add(stageAnchor);

  try {
    const { createHall } = await import('./scene/Hall.js');
    const built = createHall(scene, {});
    hall = built;
    if (built && built.stageAnchor) stageAnchor = built.stageAnchor;

    const { createLighting } = await import('./scene/Lighting.js');
    lighting = createLighting(scene, stageAnchor, {});

    setStatus('Loading performer…');
    const { Performer } = await import('./scene/Performer.js');
    performer = await Performer.load(manifest, {
      onProgress: (frac) => setProgress(0.5 + frac * 0.45),
    });
    if (performer && performer.object3d) {
      performer.object3d.position.copy(stageAnchor.getWorldPosition(new THREE.Vector3()));
      scene.add(performer.object3d);
    }
  } catch (err) {
    // Scene modules (Task B) not present yet or failed. The shell + clock still work.
    console.warn('[main] scene modules unavailable, running shell-only:', err.message);
    setStatus('Scene modules pending (Task B) — running shell only.');
    if (!lighting) {
      const amb = new THREE.AmbientLight(0x404050, 1.2);
      const spot = new THREE.SpotLight(0xffffff, 60, 0, Math.PI / 6, 0.4, 1.2);
      spot.position.set(0, 8, 6);
      spot.castShadow = true;
      scene.add(amb, spot);
    }
  }

  setProgress(0.98);

  // 5) Camera — fixed audience POV aimed at the stage.
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(0, 3.2, 12);
  const target = stageAnchor.getWorldPosition(new THREE.Vector3());
  target.y += 1.6;
  camera.lookAt(target);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 4;
  controls.maxDistance = 40;
  controls.maxPolarAngle = Math.PI * 0.52;
  controls.update();

  // 6) Transport UI.
  const ui = new TransportUI(clock);

  // First-gesture autoplay hint.
  clock.on('autoplayblocked', () => { hintEl.textContent = 'Press Play ▶ to start'; });

  // 7) Reveal.
  setProgress(1);
  transportEl.classList.remove('hidden');
  overlay.classList.add('hidden');

  // 8) Resize.
  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  }
  window.addEventListener('resize', onResize);

  // 9) RENDER LOOP — audio-slaved. NEVER deltaTime into the performer.
  function frame() {
    const t = clock.currentTime;
    if (performer) performer.update(t);
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Expose for debugging.
  window.__mjj = { clock, ui, renderer, scene, camera, performer, hall, lighting };
}

boot();
