// js/QualityManager.js — quality preset owner (Phase 5).
//
// Single source of truth for Low/Medium/High tiers + an auto-detect probe.
// No project imports; it receives handles (renderer now, lighting via attach()).
//
// Two apply channels:
//   RUNTIME  (live): pixelRatio clamp, spot shadow-map size, CSS overlay flag
//                    (document.body.dataset.quality drives the retro film-grain
//                     overlay in ui.css).
//   BUILD-TIME (once, read before scene construction): seat rows, avatar segments.
//   A later manual tier change does NOT rebuild the hall/avatars — cheap, no
//   dispose churn. The UI selectors note "applies fully after reload".
//
// Contract (consumed by main.js + GuestBar.js + HostPanel.js):
//   const qm = new QualityManager(renderer);   // reads localStorage 'mjj.quality'
//   qm.mode / qm.tier                            // 'auto'|forced  /  resolved tier
//   qm.buildOpts()                               // { seatRows, avatarSegments }
//   qm.attach({ lighting })                      // lighting may be null
//   qm.set(value)                                // persist + apply runtime + onChange
//   qm.onChange(cb)                              // cb(tier, mode)
//   qm.startFpsSample()                          // auto mode only, one-shot

const STORAGE_KEY = 'mjj.quality';

// Single source of truth for every knob.
const TIERS = {
  low:    { pixelRatioClamp: 1,   shadowMapSize: 512,  grain: 'off', seatRows: 10, avatarSegments: [4, 8] },
  medium: { pixelRatioClamp: 1.5, shadowMapSize: 1024, grain: 'on',  seatRows: 16, avatarSegments: [6, 12] },
  high:   { pixelRatioClamp: 2,   shadowMapSize: 2048, grain: 'on',  seatRows: 16, avatarSegments: [6, 12] },
};
const TIER_ORDER = ['low', 'medium', 'high'];

export class QualityManager {
  /** @param {THREE.WebGLRenderer} renderer */
  constructor(renderer) {
    this.renderer = renderer;
    this.lighting = null;
    this._listeners = [];
    this._fpsSampled = false;

    // 1) Read persisted preference.
    let stored = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch (e) {}
    if (stored !== 'auto' && stored !== 'low' && stored !== 'medium' && stored !== 'high') {
      stored = 'auto';
    }
    this.mode = stored;                 // 'auto' | forced tier
    this.tier = this._probe(this.mode); // resolved tier — valid immediately (sync)

    // Apply runtime knobs right away so the renderer honours the tier from frame 0.
    this._applyRuntime();
  }

  // ---------------- probe (sync, before scene build) ----------------
  _probe(mode) {
    // Forced tier → use it, skip GPU probe.
    if (mode === 'low' || mode === 'medium' || mode === 'high') return mode;

    // Auto: inspect the GPU renderer string.
    let gpu = '';
    try {
      const gl = this.renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
                : String(gl.getParameter(gl.RENDERER));
    } catch (e) { gpu = ''; }

    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;

    if (/SwiftShader|Intel.*(HD|UHD|Iris)/i.test(gpu)) return 'low';
    if (/Apple M\d|RTX|GTX 16|Radeon RX 6|RX 7/i.test(gpu) && dpr >= 2) return 'high';
    // Everything else (incl. Radeon Pro 5500M = target MBP) → medium.
    return 'medium';
  }

  // ---------------- build-time knobs ----------------
  buildOpts() {
    const t = TIERS[this.tier];
    return { seatRows: t.seatRows, avatarSegments: t.avatarSegments.slice() };
  }

  // ---------------- handles ----------------
  attach({ lighting } = {}) {
    this.lighting = lighting || null;
    // Push the current shadow-map size to a freshly-attached lighting rig.
    if (this.lighting && typeof this.lighting.setShadowMapSize === 'function') {
      this.lighting.setShadowMapSize(TIERS[this.tier].shadowMapSize);
    }
  }

  // ---------------- setting a tier ----------------
  set(value) {
    if (value !== 'auto' && value !== 'low' && value !== 'medium' && value !== 'high') return;
    this.mode = value;
    this.tier = this._probe(value);
    try { localStorage.setItem(STORAGE_KEY, value); } catch (e) {}
    this._applyRuntime();
    this._emit();
  }

  _applyTier(tier) {
    // Internal: switch resolved tier without changing persisted mode (used by the
    // one-shot fps auto-step). Only runtime knobs change.
    if (!TIERS[tier] || tier === this.tier) return;
    this.tier = tier;
    this._applyRuntime();
    this._emit();
  }

  _applyRuntime() {
    const t = TIERS[this.tier];
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    if (this.renderer && this.renderer.setPixelRatio) {
      this.renderer.setPixelRatio(Math.min(dpr, t.pixelRatioClamp));
    }
    if (this.lighting && typeof this.lighting.setShadowMapSize === 'function') {
      this.lighting.setShadowMapSize(t.shadowMapSize);
    }
    if (typeof document !== 'undefined' && document.body) {
      document.body.dataset.quality = this.tier;
    }
  }

  /** Current pixel-ratio clamp — resize handlers use this instead of a hardcoded 2. */
  pixelRatioClamp() { return TIERS[this.tier].pixelRatioClamp; }

  // ---------------- change subscription ----------------
  onChange(cb) {
    if (typeof cb === 'function') this._listeners.push(cb);
    return () => {
      const i = this._listeners.indexOf(cb);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }

  _emit() {
    for (const cb of this._listeners) {
      try { cb(this.tier, this.mode); } catch (e) {}
    }
  }

  // ---------------- one-shot fps auto-adjust (auto mode only) ----------------
  startFpsSample() {
    if (this._fpsSampled) return;         // one adjustment per session, never oscillates
    if (this.mode !== 'auto') return;     // forced tiers are never auto-stepped
    this._fpsSampled = true;

    const frames = [];
    const DURATION_MS = 5000;
    let start = null;

    const tick = (now) => {
      if (start == null) { start = now; frames.push(now); requestAnimationFrame(tick); return; }
      frames.push(now);
      if (now - start < DURATION_MS) { requestAnimationFrame(tick); return; }
      this._finishFpsSample(frames);
    };
    requestAnimationFrame(tick);
  }

  _finishFpsSample(frames) {
    if (frames.length < 3) return;
    const deltas = [];
    for (let i = 1; i < frames.length; i++) deltas.push(frames[i] - frames[i - 1]);
    deltas.sort((a, b) => a - b);
    const medDelta = deltas[Math.floor(deltas.length / 2)];
    if (!(medDelta > 0)) return;
    const medFps = 1000 / medDelta;

    if (medFps < 45) {
      const i = TIER_ORDER.indexOf(this.tier);
      if (i > 0) this._applyTier(TIER_ORDER[i - 1]);   // step down one tier
    } else if (medFps > 58 && this.tier === 'low') {
      this._applyTier('medium');                        // step up from low
    }
  }
}
