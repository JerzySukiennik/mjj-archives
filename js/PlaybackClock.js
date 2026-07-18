// js/PlaybackClock.js — the single source of truth for time.
// SOLE owner of the <audio> element; no other module may hold a reference to it
// or call play/pause/seek on it directly. Pure audio/DOM module (no three.js
// imports) so the renderer today and Firestore netcode later consume the exact
// same surface.

export class PlaybackClock {
  /**
   * @param {string} audioUrl absolute/resolved URL to the master audio.
   * @param {{ duration:number }} opts manifest duration fallback until metadata loads.
   */
  constructor(audioUrl, { duration } = {}) {
    this._manifestDuration = Number(duration) || 0;
    this._state = 'loading';
    this._listeners = new Map(); // event -> Set<cb>

    const audio = new Audio();
    audio.preload = 'auto';
    audio.crossOrigin = 'anonymous';
    // RAW playbackRate: 0.5x = deep, 2x = chipmunk. Kill pitch preservation.
    audio.preservesPitch = false;
    audio.mozPreservesPitch = false;
    audio.webkitPreservesPitch = false;
    audio.src = audioUrl;
    this._audio = audio;

    audio.addEventListener('loadedmetadata', () => {
      if (this._manifestDuration &&
          Number.isFinite(audio.duration) &&
          Math.abs(audio.duration - this._manifestDuration) > 0.5) {
        console.warn(
          `[PlaybackClock] duration mismatch: manifest ${this._manifestDuration}s ` +
          `vs audio ${audio.duration.toFixed(2)}s`
        );
      }
      if (this._state === 'loading') this._setState('ready');
    });
    audio.addEventListener('canplay', () => {
      if (this._state === 'loading') this._setState('ready');
    });
    audio.addEventListener('play', () => this._setState('playing'));
    audio.addEventListener('pause', () => {
      if (this._state !== 'ended') this._setState('paused');
    });
    audio.addEventListener('ended', () => this._setState('ended'));
    audio.addEventListener('timeupdate', () => this._emit('timeupdate'));
    audio.addEventListener('seeked', () => this._emit('seeked'));
    audio.addEventListener('ratechange', () => this._emit('ratechange'));
    audio.addEventListener('error', () => {
      this._setState('error');
      this._emit('error', audio.error);
    });
  }

  // ---------------- read surface (renderer hot path) ----------------
  get currentTime() { return this._audio.currentTime; }

  get duration() {
    const d = this._audio.duration;
    return Number.isFinite(d) && d > 0 ? d : this._manifestDuration;
  }

  get rate() { return this._audio.playbackRate; }

  get state() { return this._state; }

  get playing() { return this._state === 'playing'; }

  // Per-client LOCAL mute. Networked mute is retired (Phase 4): mute never
  // crosses the wire; the clock stays the sole <audio> owner so this lives here.
  get muted() { return this._audio.muted; }

  // ---------------- control surface (UI now, netcode later) ----------------
  async play() {
    try {
      await this._audio.play();
    } catch (err) {
      // Autoplay rejection (no user gesture yet). Stay 'ready' and surface a hint.
      console.warn('[PlaybackClock] play() rejected:', err && err.message);
      if (this._state === 'playing') this._setState('paused');
      this._emit('autoplayblocked', err);
    }
  }

  pause() { this._audio.pause(); }

  async toggle() {
    if (this.playing) this.pause();
    else await this.play();
  }

  seek(t) {
    const dur = this.duration || 0;
    const clamped = Math.min(Math.max(Number(t) || 0, 0), dur);
    this._audio.currentTime = clamped;
    // If we had ended, a seek backward makes us paused again.
    if (this._state === 'ended' && clamped < dur) this._setState('paused');
  }

  setRate(r) {
    const clamped = Math.min(Math.max(Number(r) || 1, 0.25), 2);
    this._audio.playbackRate = clamped;
  }

  /** Local (per-client) mute toggle. Emits 'mutechange' with the new boolean. */
  setMuted(bool) {
    const next = !!bool;
    if (this._audio.muted === next) return;
    this._audio.muted = next;
    this._emit('mutechange', next);
  }

  // ---------------- events ----------------
  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(cb);
    return () => {
      const set = this._listeners.get(event);
      if (set) set.delete(cb);
    };
  }

  // ---------------- internals ----------------
  _setState(next) {
    if (this._state === next) return;
    this._state = next;
    this._emit('statechange', next);
  }

  _emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try { cb(payload); } catch (err) { console.error(`[PlaybackClock] listener error on '${event}':`, err); }
    }
  }
}
