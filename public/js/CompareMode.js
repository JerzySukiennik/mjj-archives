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
  background: #0a0a0a;
  border-left: 1px solid #ffb000;
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.6);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
}
.cmp-panel.cmp-open { display: flex; }
.cmp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: #141414;
  border-bottom: 1px solid #6a4a00;
  color: #ffb000;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-shadow: 0 0 6px rgba(255, 176, 0, 0.4);
  user-select: none;
}
.cmp-close {
  cursor: pointer;
  background: transparent;
  border: 1px solid #6a4a00;
  color: #ffb000;
  font-family: inherit;
  font-size: 12px;
  line-height: 1;
  padding: 2px 8px;
}
.cmp-close:hover { background: #2a1e00; }
.cmp-body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  overflow: hidden;
}
.cmp-body video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}
.cmp-message {
  color: #cc9a3a;
  font-size: 13px;
  padding: 24px;
  text-align: center;
  line-height: 1.5;
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
