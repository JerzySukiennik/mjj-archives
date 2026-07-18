// js/ui/GuestBar.js — minimal bottom strip for GUESTS. Display + local mute only.
// No seek, no keyboard, no transport writes: the clock is host-authoritative and
// driven remotely by Room. Time readout is an rAF poll of the clock.

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export class GuestBar {
  /** @param {import('../PlaybackClock.js').PlaybackClock} clock */
  constructor(clock) {
    this.clock = clock;
    this._unsubs = [];

    this.root = document.getElementById('guest-bar');
    this.root.classList.remove('hidden');
    this.root.innerHTML = `
      <div class="gb-inner">
        <span class="gb-label">HOST CONTROLLED</span>
        <div class="gb-readout"><span id="gb-time-cur">0:00</span> / <span id="gb-time-tot">0:00</span></div>
        <button id="gb-mute" class="hp-btn hp-btn-sm" title="Mute (local only)">MUTE</button>
        <label class="gb-quality">
          <span>QUALITY</span>
          <select id="gb-quality-sel" disabled title="Coming in Phase 5">
            <option value="auto" selected>AUTO</option>
            <option value="low">LOW</option>
            <option value="med">MED</option>
            <option value="high">HIGH</option>
          </select>
        </label>
      </div>
    `;

    this.timeCur = this.root.querySelector('#gb-time-cur');
    this.timeTot = this.root.querySelector('#gb-time-tot');
    this.muteBtn = this.root.querySelector('#gb-mute');

    this.muteBtn.addEventListener('click', () => this.clock.setMuted(!this.clock.muted));
    this._unsubs.push(this.clock.on('mutechange', () => this._syncMute()));
    this._unsubs.push(this.clock.on('statechange', () => { this.timeTot.textContent = fmtTime(this.clock.duration); }));

    this.timeTot.textContent = fmtTime(this.clock.duration);
    this._syncMute();

    this._raf = this._raf.bind(this);
    requestAnimationFrame(this._raf);
  }

  _syncMute() {
    const m = this.clock.muted;
    this.muteBtn.textContent = m ? 'UNMUTE' : 'MUTE';
    this.muteBtn.classList.toggle('active', m);
  }

  _raf() {
    if (this._disposed) return;
    this.timeCur.textContent = fmtTime(this.clock.currentTime);
    this.timeTot.textContent = fmtTime(this.clock.duration);
    requestAnimationFrame(this._raf);
  }

  dispose() {
    this._disposed = true;
    for (const u of this._unsubs) u();
    this._unsubs = [];
    if (this.root) this.root.classList.add('hidden');
  }
}
