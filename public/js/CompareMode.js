// js/CompareMode.js — passive side-by-side reference-video follower.
// Shows the original Motown 25 broadcast in a right-half overlay, driven from the
// PlaybackClock playhead. The audio master stays the m4a — this <video> is
// permanently muted and NEVER touches the clock's control surface (no
// play/pause/seek issued at the clock). Compare is a follower, not a driver.
//
// The 85MB reference file is gitignored and lazy-loaded ONLY on first toggle.
// On the deployed site it 404s (not bundled) -> friendly message, panel still works.
// All CSS lives in an injected <style> tag here — css/ui.css is deliberately untouched.

const SYNC_INTERVAL_MS = 250;
const DRIFT_THRESHOLD_S = 0.1;
const STYLE_ID = 'compare-mode-style';

// Colours mirror css/ui.css deck tokens (--amber #ffb347 / --hp-border rgba).
const CSS = `
.cmp-panel {
  position: fixed;
  top: 0;
  right: 0;
  width: 50vw;
  height: calc(100vh - 160px);
  z-index: 40;
  display: none;
  flex-direction: column;
  background: linear-gradient(180deg, #16130f 0%, #0a0908 100%);
  border-left: 1px solid rgba(255, 179, 71, 0.30);
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.6), inset 1px 0 0 rgba(255, 179, 71, 0.06);
  font-family: "Courier New", ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
}
.cmp-panel.cmp-open { display: flex; }
.cmp-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 12px;
  background:
    repeating-linear-gradient(0deg,
      rgba(255, 179, 71, 0.04) 0px, rgba(255, 179, 71, 0.04) 1px,
      transparent 1px, transparent 3px),
    linear-gradient(180deg, #262421 0%, #16130f 100%);
  border-bottom: 1px solid rgba(255, 179, 71, 0.30);
  color: #ffb347;
  font-size: 12px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  text-shadow: 0 0 6px rgba(255, 179, 71, 0.35);
  user-select: none;
}
/* 'ARCHIVE' tape-label chip pinned to the header corner. */
.cmp-header::before {
  content: "REC · ARCHIVE";
  order: -1;
  padding: 2px 7px;
  border: 1px solid #c8863b;
  border-radius: 3px;
  background: rgba(255, 179, 71, 0.05);
  color: #c8863b;
  font-size: 9px;
  font-weight: bold;
  letter-spacing: 0.24em;
  font-variant: small-caps;
  text-shadow: none;
  white-space: nowrap;
}
.cmp-close {
  cursor: pointer;
  background: #1c1a16;
  border: 1px solid rgba(255, 179, 71, 0.30);
  border-radius: 4px;
  color: #ffb347;
  font-family: inherit;
  font-size: 12px;
  line-height: 1;
  padding: 3px 9px;
  box-shadow: inset 0 1px 0 rgba(255, 179, 71, 0.08);
  transition: background 0.12s ease, box-shadow 0.12s ease;
}
.cmp-close:hover { background: #2a2620; box-shadow: 0 0 10px rgba(255, 179, 71, 0.35); }
.cmp-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  overflow: hidden;
}
/* Subtle inner vignette on the video/message well for depth. */
.cmp-body::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  box-shadow: inset 0 0 120px rgba(0, 0, 0, 0.7);
}
.cmp-body video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}
.cmp-message {
  position: relative;
  z-index: 1;
  color: #c8863b;
  font-size: 13px;
  padding: 24px;
  text-align: center;
  line-height: 1.5;
  letter-spacing: 0.06em;
}
`;

export class CompareMode {
  /**
   * @param {import('./PlaybackClock.js').PlaybackClock} clock  the shared clock (read-only here).
   * @param {object} manifest  resolved concert manifest; uses manifest.referenceVideo.
   */
  constructor(clock, manifest) {
    this._clock = clock;
    this._manifest = manifest;
    this._active = false;
    this._built = false;

    this._panel = null;
    this._video = null;
    this._interval = null;
    this._unsubSeeked = null;
  }

  /**
   * Toggle the compare panel. Lazy-builds DOM + injects style on first call.
   * @returns {boolean} the new active state.
   */
  toggle() {
    if (!this._built) this._build();
    if (this._active) this._deactivate();
    else this._activate();
    return this._active;
  }

  // ---------------- lazy build ----------------
  _build() {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const panel = document.createElement('div');
    panel.className = 'cmp-panel';

    const header = document.createElement('div');
    header.className = 'cmp-header';
    const title = document.createElement('span');
    title.textContent = 'REFERENCE — MOTOWN 25 BROADCAST';
    const close = document.createElement('button');
    close.className = 'cmp-close';
    close.type = 'button';
    close.textContent = '✕';
    close.addEventListener('click', () => this.toggle());
    header.appendChild(title);
    header.appendChild(close);

    const body = document.createElement('div');
    body.className = 'cmp-body';

    const src = this._manifest && this._manifest.referenceVideo;
    if (!src) {
      body.appendChild(this._makeMessage());
      console.info('[CompareMode] No referenceVideo in manifest — reference not bundled.');
    } else {
      const video = document.createElement('video');
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.crossOrigin = 'anonymous';
      // Keep the video permanently silent — the m4a is the audio master.
      video.addEventListener('volumechange', () => { if (!video.muted) video.muted = true; });
      video.addEventListener('error', () => this._showError(), { once: true });
      video.src = src;
      this._video = video;
      body.appendChild(video);
    }

    panel.appendChild(header);
    panel.appendChild(body);
    this._body = body;
    document.body.appendChild(panel);
    this._panel = panel;
    this._built = true;
  }

  _makeMessage() {
    const msg = document.createElement('div');
    msg.className = 'cmp-message';
    msg.textContent = 'Reference video not bundled with this deployment.';
    return msg;
  }

  _showError() {
    console.info('[CompareMode] Reference video failed to load — not bundled with this deployment.');
    if (this._video && this._video.parentNode) this._video.parentNode.removeChild(this._video);
    this._video = null;
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
    if (this._body) this._body.appendChild(this._makeMessage());
  }

  // ---------------- activate / deactivate ----------------
  _activate() {
    this._active = true;
    this._panel.classList.add('cmp-open');
    if (this._video) {
      this._syncOnce();
      this._interval = setInterval(() => this._syncOnce(), SYNC_INTERVAL_MS);
      this._unsubSeeked = this._clock.on('seeked', () => this._syncOnce());
    }
  }

  _deactivate() {
    this._active = false;
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
    if (this._unsubSeeked) { this._unsubSeeked(); this._unsubSeeked = null; }
    if (this._video) this._video.pause();
    this._panel.classList.remove('cmp-open');
  }

  // ---------------- passive sync ----------------
  _syncOnce() {
    const v = this._video;
    if (!v) return;
    // Mirror rate + play/pause from the clock; never drive the clock from here.
    if (v.playbackRate !== this._clock.rate) v.playbackRate = this._clock.rate;
    if (this._clock.playing) {
      if (v.paused) v.play().catch(() => {});
    } else if (!v.paused) {
      v.pause();
    }
    if (Math.abs(v.currentTime - this._clock.currentTime) > DRIFT_THRESHOLD_S) {
      v.currentTime = this._clock.currentTime;
    }
  }

  // ---------------- teardown ----------------
  dispose() {
    this._deactivate();
    if (this._video) { this._video.removeAttribute('src'); this._video.load?.(); this._video = null; }
    if (this._panel && this._panel.parentNode) this._panel.parentNode.removeChild(this._panel);
    this._panel = null;
    this._body = null;
    const style = document.getElementById(STYLE_ID);
    if (style && style.parentNode) style.parentNode.removeChild(style);
    this._built = false;
  }
}
