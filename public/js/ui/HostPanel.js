// js/ui/HostPanel.js — the full retro-'83 mixing-console / archive deck.
// HOST ONLY. Bottom-docked, collapsible. Transport basics talk STRAIGHT to the
// PlaybackClock (host authority propagates through Room's existing clock
// listeners → anchor republish); it does NOT import Room. Room-scoped actions
// (stop, lighting, A-B loop, reset, kick, compare) go through the callbacks.
//
//   new HostPanel(clock, callbacks, { markersUrl, duration })
//   callbacks = { onLighting, onSetLoopA, onSetLoopB, onClearLoop,
//                 onResetSeats, onKick, onCompareToggle, onStop, onRestart }

const SEEK_RESOLUTION = 1000;
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const LIGHTING_PRESETS = ['single-spot', 'full-stage', 'blackout'];

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export class HostPanel {
  /**
   * @param {import('../PlaybackClock.js').PlaybackClock} clock
   * @param {object} callbacks
   * @param {{ markersUrl?: string|null, duration?: number }} [opts]
   */
  constructor(clock, callbacks = {}, opts = {}) {
    this.clock = clock;
    this.cb = callbacks;
    this.markersUrl = opts.markersUrl || null;

    this._scrubbing = false;
    this._collapsed = false;
    this._unsubs = [];
    this._markers = []; // [{ id, name, t }]
    this._loop = null;  // { a, b } | null
    this._lighting = 'single-spot';

    this.root = document.getElementById('host-panel');
    this._build();
    this._bind();
    this._render();
    this._loadMarkers();

    this._raf = this._raf.bind(this);
    requestAnimationFrame(this._raf);
  }

  // ---------------- DOM construction ----------------
  _build() {
    this.root.classList.remove('hidden');
    this.root.innerHTML = `
      <button id="hp-collapse" class="hp-collapse" title="Collapse / expand deck">▾</button>
      <div class="hp-deck">
        <!-- LEFT: TRANSPORT -->
        <section class="hp-section hp-transport">
          <div class="hp-section-label">Transport</div>
          <div class="hp-btn-row">
            <button id="hp-stop" class="hp-btn" title="Stop (return to lobby)">■ STOP</button>
            <button id="hp-back10" class="hp-btn" title="Back 10s (←)">−10s</button>
            <button id="hp-play" class="hp-btn hp-btn-big" title="Play / Pause (Space)">▶ PLAY</button>
            <button id="hp-fwd10" class="hp-btn" title="Forward 10s (→)">+10s</button>
            <button id="hp-restart" class="hp-btn" title="Restart (R)">⟲ RESTART</button>
          </div>
        </section>

        <!-- CENTER: TAPE -->
        <section class="hp-section hp-tape">
          <div class="hp-section-label">Tape</div>
          <div class="hp-readout"><span id="hp-time-cur">0:00</span> / <span id="hp-time-tot">0:00</span></div>
          <div class="hp-track-wrap">
            <div id="hp-flag-a" class="hp-flag hp-flag-a hidden" title="Loop A">A</div>
            <div id="hp-flag-b" class="hp-flag hp-flag-b hidden" title="Loop B">B</div>
            <input id="hp-seek" class="hp-seek" type="range" min="0" max="${SEEK_RESOLUTION}" value="0" step="1" aria-label="Seek" />
          </div>
          <div id="hp-markers" class="hp-markers hidden"></div>
          <div class="hp-ab-row">
            <button id="hp-set-a" class="hp-btn hp-btn-sm" title="Set loop A ([)">SET A</button>
            <button id="hp-set-b" class="hp-btn hp-btn-sm" title="Set loop B (])">SET B</button>
            <button id="hp-clear-loop" class="hp-btn hp-btn-sm" title="Clear loop (\\)">CLEAR</button>
          </div>
        </section>

        <!-- RIGHT: DECK -->
        <section class="hp-section hp-deckcluster">
          <div class="hp-section-label">Deck</div>
          <div class="hp-deck-row">
            <div class="hp-stepper">
              <button id="hp-tempo-down" class="hp-btn hp-btn-sm" title="Tempo down (-)">−</button>
              <span id="hp-tempo-read" class="hp-tempo-read">1×</span>
              <button id="hp-tempo-up" class="hp-btn hp-btn-sm" title="Tempo up (=)">+</button>
            </div>
            <button id="hp-mute" class="hp-btn hp-btn-sm" title="Mute (M) — local only">MUTE</button>
          </div>
          <div class="hp-deck-row">
            <div class="hp-lights">
              <button class="hp-btn hp-btn-sm hp-light" data-preset="single-spot" title="Single spot">SPOT</button>
              <button class="hp-btn hp-btn-sm hp-light" data-preset="full-stage" title="Full stage">FULL</button>
              <button class="hp-btn hp-btn-sm hp-light" data-preset="blackout" title="Blackout">BLACK</button>
            </div>
          </div>
          <div class="hp-deck-row">
            <button id="hp-compare" class="hp-btn hp-btn-sm" title="Compare with original video">COMPARE</button>
            <button id="hp-players-toggle" class="hp-btn hp-btn-sm" title="Players / ready check">PLAYERS</button>
          </div>
        </section>

        <!-- PLAYERS DRAWER -->
        <aside id="hp-drawer" class="hp-drawer hidden">
          <div class="hp-drawer-head">
            <span>Players</span>
            <button id="hp-reset-seats" class="hp-btn hp-btn-sm" title="Reset everyone to seats">RESET TO SEATS</button>
          </div>
          <ul id="hp-players" class="hp-players"></ul>
        </aside>
      </div>
    `;

    // Cache refs.
    const $ = (id) => this.root.querySelector('#' + id);
    this.el = {
      collapse: $('hp-collapse'),
      deck: this.root.querySelector('.hp-deck'),
      stop: $('hp-stop'), back10: $('hp-back10'), play: $('hp-play'),
      fwd10: $('hp-fwd10'), restart: $('hp-restart'),
      timeCur: $('hp-time-cur'), timeTot: $('hp-time-tot'),
      seek: $('hp-seek'), flagA: $('hp-flag-a'), flagB: $('hp-flag-b'),
      markers: $('hp-markers'),
      setA: $('hp-set-a'), setB: $('hp-set-b'), clearLoop: $('hp-clear-loop'),
      tempoDown: $('hp-tempo-down'), tempoUp: $('hp-tempo-up'), tempoRead: $('hp-tempo-read'),
      mute: $('hp-mute'),
      lights: Array.from(this.root.querySelectorAll('.hp-light')),
      compare: $('hp-compare'),
      playersToggle: $('hp-players-toggle'),
      drawer: $('hp-drawer'), players: $('hp-players'), resetSeats: $('hp-reset-seats'),
    };
  }

  // ---------------- event wiring ----------------
  _bind() {
    const e = this.el;

    e.collapse.addEventListener('click', () => this._toggleCollapse());

    // Transport basics -> straight to the clock.
    e.play.addEventListener('click', () => this.clock.toggle());
    e.stop.addEventListener('click', () => this.cb.onStop && this.cb.onStop());
    e.restart.addEventListener('click', () => this.cb.onRestart && this.cb.onRestart());
    e.back10.addEventListener('click', () => this.clock.seek(this.clock.currentTime - 10));
    e.fwd10.addEventListener('click', () => this.clock.seek(this.clock.currentTime + 10));

    // Scrub bar (reuses the TransportUI pattern + _scrubbing guard).
    e.seek.addEventListener('pointerdown', () => { this._scrubbing = true; });
    e.seek.addEventListener('input', () => {
      const t = (e.seek.value / SEEK_RESOLUTION) * (this.clock.duration || 0);
      this.clock.seek(t);
      e.timeCur.textContent = fmtTime(t);
      this._paintSeekFill();
    });
    const endScrub = () => {
      const t = (e.seek.value / SEEK_RESOLUTION) * (this.clock.duration || 0);
      this.clock.seek(t);
      this._scrubbing = false;
    };
    e.seek.addEventListener('change', endScrub);
    e.seek.addEventListener('pointerup', endScrub);

    // A-B loop.
    e.setA.addEventListener('click', () => this.cb.onSetLoopA && this.cb.onSetLoopA(this.clock.currentTime));
    e.setB.addEventListener('click', () => this.cb.onSetLoopB && this.cb.onSetLoopB(this.clock.currentTime));
    e.clearLoop.addEventListener('click', () => this.cb.onClearLoop && this.cb.onClearLoop());

    // Tempo stepper.
    e.tempoDown.addEventListener('click', () => this.stepTempo(-1));
    e.tempoUp.addEventListener('click', () => this.stepTempo(1));

    // Mute (local).
    e.mute.addEventListener('click', () => this.clock.setMuted(!this.clock.muted));

    // Lighting 3-way.
    for (const btn of e.lights) {
      btn.addEventListener('click', () => this.cb.onLighting && this.cb.onLighting(btn.dataset.preset));
    }

    // Compare.
    e.compare.addEventListener('click', () => this.cb.onCompareToggle && this.cb.onCompareToggle());

    // Players drawer.
    e.playersToggle.addEventListener('click', () => {
      e.drawer.classList.toggle('hidden');
      e.playersToggle.classList.toggle('active', !e.drawer.classList.contains('hidden'));
    });
    e.resetSeats.addEventListener('click', () => this.cb.onResetSeats && this.cb.onResetSeats());

    // Clock event subscriptions.
    this._unsubs.push(this.clock.on('statechange', () => this._render()));
    this._unsubs.push(this.clock.on('ratechange', () => this._syncTempo()));
    this._unsubs.push(this.clock.on('mutechange', () => this._syncMute()));
    this._unsubs.push(this.clock.on('seeked', () => { if (!this._scrubbing) this._syncSeek(); }));
  }

  _toggleCollapse() {
    this._collapsed = !this._collapsed;
    this.root.classList.toggle('collapsed', this._collapsed);
    this.el.collapse.textContent = this._collapsed ? '▴' : '▾';
  }

  // ---------------- markers ----------------
  async _loadMarkers() {
    if (!this.markersUrl) { this._hideMarkerRow(); return; }
    try {
      const res = await fetch(this.markersUrl, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const raw = await res.json();
      const arr = Array.isArray(raw) ? raw : [];
      this._markers = arr.map((m) => ({
        id: m.id || m.label || '',
        name: m.name || m.label || m.id || '?',
        t: Number(m.t != null ? m.t : m.time) || 0,
      })).slice(0, 9);
      if (this._markers.length === 0) { this._hideMarkerRow(); return; }
      this._renderMarkers();
    } catch (err) {
      console.info('markers.json not available yet');
      this._hideMarkerRow();
    }
  }

  _hideMarkerRow() {
    this._markers = [];
    if (this.el.markers) this.el.markers.classList.add('hidden');
  }

  _renderMarkers() {
    const dur = this.clock.duration || 1;
    const box = this.el.markers;
    box.classList.remove('hidden');
    box.innerHTML = '';
    this._markers.forEach((m, i) => {
      const chip = document.createElement('button');
      chip.className = 'hp-marker';
      chip.style.left = Math.min(100, Math.max(0, (m.t / dur) * 100)) + '%';
      chip.title = `${m.name} — ${fmtTime(m.t)}`;
      chip.innerHTML = `<span class="hp-marker-num">${i + 1}</span><span class="hp-marker-name">${m.name}</span>`;
      chip.addEventListener('click', () => this.clock.seek(m.t));
      box.appendChild(chip);
    });
  }

  getMarkers() { return this._markers; }

  /** Jump to marker N (1-based). No-op if missing. */
  jumpToMarker(n) {
    const m = this._markers[n - 1];
    if (m) this.clock.seek(m.t);
  }

  // ---------------- tempo ----------------
  stepTempo(dir) {
    const cur = this.clock.rate;
    // Find nearest index in the fixed list, then step.
    let idx = RATES.indexOf(cur);
    if (idx === -1) {
      idx = RATES.reduce((best, r, i) =>
        Math.abs(r - cur) < Math.abs(RATES[best] - cur) ? i : best, 0);
    }
    idx = Math.min(RATES.length - 1, Math.max(0, idx + Math.sign(dir)));
    this.clock.setRate(RATES[idx]);
  }

  // ---------------- players drawer ----------------
  updatePlayers(players) {
    const list = Array.isArray(players) ? players : [];
    const ul = this.el.players;
    ul.innerHTML = '';
    for (const p of list) {
      const li = document.createElement('li');
      li.className = 'hp-player';

      const name = document.createElement('span');
      name.className = 'hp-player-name';
      name.textContent = (p.isHost ? '★ ' : '') + (p.name || '???');

      const right = document.createElement('span');
      right.className = 'hp-player-right';

      const badge = document.createElement('span');
      badge.className = 'hp-badge ' + (p.ready ? 'ready' : 'loading');
      badge.textContent = p.ready ? 'READY' : 'LOADING';
      right.appendChild(badge);

      if (!p.isHost) {
        const kick = document.createElement('button');
        kick.className = 'hp-btn hp-btn-sm hp-kick';
        kick.textContent = 'KICK';
        kick.title = 'Remove this player';
        kick.addEventListener('click', () => this.cb.onKick && this.cb.onKick(p.id));
        right.appendChild(kick);
      }

      li.appendChild(name);
      li.appendChild(right);
      ul.appendChild(li);
    }
  }

  // ---------------- loop / lighting / compare UI state ----------------
  setLoopUI(a, b) {
    if (a == null || b == null) {
      this._loop = null;
      this.el.flagA.classList.add('hidden');
      this.el.flagB.classList.add('hidden');
      return;
    }
    this._loop = { a, b };
    const dur = this.clock.duration || 1;
    this.el.flagA.style.left = Math.min(100, Math.max(0, (a / dur) * 100)) + '%';
    this.el.flagB.style.left = Math.min(100, Math.max(0, (b / dur) * 100)) + '%';
    this.el.flagA.classList.remove('hidden');
    this.el.flagB.classList.remove('hidden');
  }

  setLightingUI(preset) {
    if (!LIGHTING_PRESETS.includes(preset)) return;
    this._lighting = preset;
    for (const btn of this.el.lights) {
      btn.classList.toggle('active', btn.dataset.preset === preset);
    }
  }

  setCompareActive(bool) {
    this.el.compare.classList.toggle('active', !!bool);
  }

  // ---------------- render helpers ----------------
  _render() {
    this.el.play.textContent = this.clock.playing ? '❚❚ PAUSE' : '▶ PLAY';
    this.el.timeTot.textContent = fmtTime(this.clock.duration);
    this._syncTempo();
    this._syncMute();
    this._syncSeek();
    this.setLightingUI(this._lighting);
  }

  _syncTempo() {
    this.el.tempoRead.textContent = this.clock.rate + '×';
  }

  _syncMute() {
    const m = this.clock.muted;
    this.el.mute.textContent = m ? 'UNMUTE' : 'MUTE';
    this.el.mute.classList.toggle('active', m);
  }

  _syncSeek() {
    const dur = this.clock.duration || 0;
    const frac = dur > 0 ? this.clock.currentTime / dur : 0;
    this.el.seek.value = Math.round(frac * SEEK_RESOLUTION);
    this.el.timeCur.textContent = fmtTime(this.clock.currentTime);
    this._paintSeekFill();
  }

  _paintSeekFill() {
    const pct = (this.el.seek.value / SEEK_RESOLUTION) * 100;
    this.el.seek.style.setProperty('--seek', pct + '%');
  }

  _raf() {
    if (this._disposed) return;
    if (!this._scrubbing) this._syncSeek();
    requestAnimationFrame(this._raf);
  }

  dispose() {
    this._disposed = true;
    for (const u of this._unsubs) u();
    this._unsubs = [];
    if (this.root) this.root.classList.add('hidden');
  }
}
