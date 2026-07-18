// js/TransportUI.js — transport controls. Talks ONLY to the PlaybackClock public
// API. Renders from clock events + a lightweight rAF poll for the seek bar.

const SEEK_RESOLUTION = 1000; // range input steps 0..1000

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export class TransportUI {
  /**
   * @param {import('./PlaybackClock.js').PlaybackClock} clock
   * @param {object} [els] optional DOM element overrides.
   */
  constructor(clock, els = {}) {
    this.clock = clock;
    this._scrubbing = false;
    this._unsubs = [];

    this.root = els.root || document.getElementById('transport');
    this.playBtn = els.playBtn || document.getElementById('play-btn');
    this.seekBar = els.seekBar || document.getElementById('seek-bar');
    this.timeCur = els.timeCur || document.getElementById('time-current');
    this.timeTot = els.timeTot || document.getElementById('time-total');
    this.rateSel = els.rateSel || document.getElementById('rate-select');

    this.seekBar.min = 0;
    this.seekBar.max = SEEK_RESOLUTION;
    this.seekBar.step = 1;

    this._bind();
    this._render();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  _bind() {
    // Play / pause button.
    this.playBtn.addEventListener('click', () => this.clock.toggle());

    // Seek bar. While dragging, don't let the poll fight the user (feedback loop).
    const startScrub = () => { this._scrubbing = true; };
    const doScrub = () => {
      // Live seek while dragging (works paused or playing).
      const t = (this.seekBar.value / SEEK_RESOLUTION) * (this.clock.duration || 0);
      this.clock.seek(t);
      this.timeCur.textContent = fmtTime(t);
      this._paintSeekFill();
    };
    const endScrub = () => {
      const t = (this.seekBar.value / SEEK_RESOLUTION) * (this.clock.duration || 0);
      this.clock.seek(t);
      this._scrubbing = false;
    };
    this.seekBar.addEventListener('pointerdown', startScrub);
    this.seekBar.addEventListener('input', doScrub);
    this.seekBar.addEventListener('change', endScrub);
    this.seekBar.addEventListener('pointerup', endScrub);

    // Rate control.
    this.rateSel.addEventListener('change', () => {
      this.clock.setRate(parseFloat(this.rateSel.value));
    });

    // Clock events.
    this._unsubs.push(this.clock.on('statechange', () => this._render()));
    this._unsubs.push(this.clock.on('ratechange', () => this._syncRate()));
    this._unsubs.push(this.clock.on('seeked', () => { if (!this._scrubbing) this._syncSeek(); }));

    // Keyboard: Space = toggle, Left/Right = ±10s.
    this._onKey = (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
        // Let the range/select handle its own arrows, except Space toggles playback.
        if (e.code === 'Space' && tag !== 'SELECT') {
          e.preventDefault();
          this.clock.toggle();
        }
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        this.clock.toggle();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        this.clock.seek(this.clock.currentTime - 10);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        this.clock.seek(this.clock.currentTime + 10);
      }
    };
    window.addEventListener('keydown', this._onKey);
  }

  _render() {
    const playing = this.clock.playing;
    this.playBtn.textContent = playing ? '❚❚' : '▶';
    this.timeTot.textContent = fmtTime(this.clock.duration);
    this._syncRate();
    this._syncSeek();
  }

  _syncRate() {
    const r = String(this.clock.rate);
    if (this.rateSel.value !== r) {
      const opt = Array.from(this.rateSel.options).find((o) => parseFloat(o.value) === this.clock.rate);
      if (opt) this.rateSel.value = opt.value;
    }
  }

  _syncSeek() {
    const dur = this.clock.duration || 0;
    const frac = dur > 0 ? this.clock.currentTime / dur : 0;
    this.seekBar.value = Math.round(frac * SEEK_RESOLUTION);
    this.timeCur.textContent = fmtTime(this.clock.currentTime);
    this._paintSeekFill();
  }

  _paintSeekFill() {
    const pct = (this.seekBar.value / SEEK_RESOLUTION) * 100;
    this.seekBar.style.setProperty('--seek', pct + '%');
  }

  _loop() {
    if (!this._scrubbing) this._syncSeek();
    requestAnimationFrame(this._loop);
  }

  dispose() {
    for (const u of this._unsubs) u();
    window.removeEventListener('keydown', this._onKey);
  }
}
