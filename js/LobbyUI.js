// js/LobbyUI.js — owns ALL DOM inside #lobby-overlay.
// Three views inside the overlay:
//   entry  — nickname + create / join by code (client-side validated)
//   room   — big room code + player list + host Start / Leave
//   chip   — collapsed always-visible room-code chip + player list, shown while
//            walking in the hall so the overlay no longer blocks pointer lock.
// No Firestore, no three.js — pure DOM. Callbacks are supplied by main.js.

// Room-code alphabet (no I/L/O/0/1) — must match Room.create's generator.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);

export class LobbyUI {
  /** @param {HTMLElement} rootEl the #lobby-overlay element. */
  constructor(rootEl) {
    this.root = rootEl;

    // Views.
    this.entryView = rootEl.querySelector('#lobby-entry');
    this.roomView = rootEl.querySelector('#lobby-room');
    this.chip = rootEl.querySelector('#lobby-chip');

    // Entry controls.
    this.nameInput = rootEl.querySelector('#lobby-name');
    this.createBtn = rootEl.querySelector('#lobby-create');
    this.codeInput = rootEl.querySelector('#lobby-code');
    this.joinBtn = rootEl.querySelector('#lobby-join');
    this.errorEl = rootEl.querySelector('#lobby-error');

    // Room controls.
    this.roomCodeEl = rootEl.querySelector('#lobby-room-code');
    this.playersEl = rootEl.querySelector('#lobby-players');
    this.startBtn = rootEl.querySelector('#lobby-start');
    this.leaveBtn = rootEl.querySelector('#lobby-leave');
    this.statusEl = rootEl.querySelector('#lobby-status');

    // Chip controls.
    this.chipCodeEl = rootEl.querySelector('#lobby-chip-code');
    this.chipPlayersEl = rootEl.querySelector('#lobby-chip-players');
    this.chipStartBtn = rootEl.querySelector('#lobby-chip-start');

    // Uppercase the code field as the user types.
    this.codeInput.addEventListener('input', () => {
      this.codeInput.value = this.codeInput.value.toUpperCase();
    });
  }

  // ---- entry view ----
  showEntry({ onCreate, onJoin } = {}) {
    this.root.classList.remove('hidden', 'collapsed');
    this._show(this.entryView);
    this._hide(this.roomView);
    this._hide(this.chip);
    this.setError('');

    // Rebind fresh handlers (clone-free: replace the click handler each show).
    this.createBtn.onclick = () => {
      const name = this._validName();
      if (!name) return;
      this.setError('');
      onCreate && onCreate(name);
    };
    this.joinBtn.onclick = () => {
      const name = this._validName();
      if (!name) return;
      const code = this.codeInput.value.trim().toUpperCase();
      if (!CODE_RE.test(code)) {
        this.setError('Enter a valid 6-character room code.');
        return;
      }
      this.setError('');
      onJoin && onJoin(code, name);
    };
    setTimeout(() => this.nameInput.focus(), 0);
  }

  _validName() {
    const name = (this.nameInput.value || '').trim();
    if (name.length < 1 || name.length > 16) {
      this.setError('Nickname must be 1–16 characters.');
      return null;
    }
    return name;
  }

  // ---- room view (pre-walk lobby) ----
  showRoom({ room, isHost, onStart, onLeave } = {}) {
    this.root.classList.remove('hidden', 'collapsed');
    this._hide(this.entryView);
    this._show(this.roomView);
    this._hide(this.chip);
    this.roomCodeEl.textContent = room.code;
    this.chipCodeEl.textContent = room.code;

    // Start button only exists for host; disabled until all ready.
    if (isHost) {
      this._show(this.startBtn);
      this.startBtn.disabled = true;
      this.startBtn.onclick = () => onStart && onStart();
      // The chip Start (reachable while walking) shares the same gate + handler,
      // because the room view collapses to the chip once the host enters the hall.
      if (this.chipStartBtn) {
        this._show(this.chipStartBtn);
        this.chipStartBtn.disabled = true;
        this.chipStartBtn.onclick = () => onStart && onStart();
      }
    } else {
      this._hide(this.startBtn);
      if (this.chipStartBtn) this._hide(this.chipStartBtn);
    }
    this.leaveBtn.onclick = () => onLeave && onLeave();
    this.setStatus(isHost
      ? 'Standing by — waiting for all players to load…'
      : 'Standing by — waiting for the host to start playback…');
  }

  // ---- collapsed chip (while walking) ----
  collapseToChip() {
    // Keep overlay in the DOM but transparent + non-blocking so pointer lock works.
    this.root.classList.remove('hidden');
    this.root.classList.add('collapsed');
    this._hide(this.entryView);
    this._hide(this.roomView);
    this._show(this.chip);
  }

  // ---- player list (renders into both room view and chip) ----
  updatePlayers(players) {
    const list = Array.isArray(players) ? players : [];
    this._renderPlayerList(this.playersEl, list);
    this._renderPlayerList(this.chipPlayersEl, list);
  }

  _renderPlayerList(ul, players) {
    if (!ul) return;
    ul.innerHTML = '';
    for (const p of players) {
      const li = document.createElement('li');
      li.className = 'lobby-player';

      const name = document.createElement('span');
      name.className = 'lobby-player-name';
      name.textContent = p.name || '???';
      if (p.isHost) {
        const star = document.createElement('span');
        star.className = 'lobby-host-star';
        star.textContent = '★';
        star.title = 'Host';
        name.prepend(star);
      }

      const badge = document.createElement('span');
      badge.className = 'lobby-badge ' + (p.ready ? 'ready' : 'loading');
      badge.textContent = p.ready ? 'READY' : 'LOADING';

      li.appendChild(name);
      li.appendChild(badge);
      ul.appendChild(li);
    }
  }

  setStartEnabled(bool) {
    if (this.startBtn) this.startBtn.disabled = !bool;
    if (this.chipStartBtn) this.chipStartBtn.disabled = !bool;
  }

  setStatus(msg) {
    if (this.statusEl) this.statusEl.textContent = msg || '';
  }

  setError(msg) {
    if (this.errorEl) this.errorEl.textContent = msg || '';
  }

  hide() {
    this.root.classList.add('hidden');
    this.root.classList.remove('collapsed');
  }

  // ---- helpers ----
  _show(el) { if (el) el.classList.remove('hidden'); }
  _hide(el) { if (el) el.classList.add('hidden'); }
}
