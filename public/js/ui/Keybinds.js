// js/ui/Keybinds.js — the ONLY keydown listener in the app. HOST ONLY.
// Talks to the clock for transport basics and delegates loop/marker/tempo to the
// HostPanel + callbacks. Ignores events while typing in form fields.
//
//   new Keybinds(clock, hostPanel, callbacks)
//   Bindings: Space play/pause, ←/→ ±10s, R restart, [ set A, ] set B,
//             \ clear loop, 1..9 jump to marker N, M mute, -/= tempo down/up.

export class Keybinds {
  /**
   * @param {import('../PlaybackClock.js').PlaybackClock} clock
   * @param {import('./HostPanel.js').HostPanel} panel
   * @param {object} callbacks { onRestart, onSetLoopA, onSetLoopB, onClearLoop }
   */
  constructor(clock, panel, callbacks = {}) {
    this.clock = clock;
    this.panel = panel;
    this.cb = callbacks;

    this._onKey = this._handle.bind(this);
    window.addEventListener('keydown', this._onKey);
  }

  _handle(e) {
    const t = e.target;
    const tag = (t && t.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' ||
        (t && t.isContentEditable)) {
      return;
    }

    const c = e.code;

    // Digit1..Digit9 → jump to marker N.
    if (/^Digit[1-9]$/.test(c)) {
      e.preventDefault();
      this.panel.jumpToMarker(parseInt(c.slice(5), 10));
      return;
    }

    switch (c) {
      case 'Space':
        e.preventDefault();
        this.clock.toggle();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this.clock.seek(this.clock.currentTime - 10);
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.clock.seek(this.clock.currentTime + 10);
        break;
      case 'KeyR':
        e.preventDefault();
        this.cb.onRestart && this.cb.onRestart();
        break;
      case 'BracketLeft':
        e.preventDefault();
        this.cb.onSetLoopA && this.cb.onSetLoopA(this.clock.currentTime);
        break;
      case 'BracketRight':
        e.preventDefault();
        this.cb.onSetLoopB && this.cb.onSetLoopB(this.clock.currentTime);
        break;
      case 'Backslash':
        e.preventDefault();
        this.cb.onClearLoop && this.cb.onClearLoop();
        break;
      case 'KeyM':
        e.preventDefault();
        this.clock.setMuted(!this.clock.muted);
        break;
      case 'Minus':
        e.preventDefault();
        this.panel.stepTempo(-1);
        break;
      case 'Equal':
        e.preventDefault();
        this.panel.stepTempo(1);
        break;
      default:
        break;
    }
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
  }
}
