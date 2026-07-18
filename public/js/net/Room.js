// js/net/Room.js — the multiplayer state machine and host-authoritative clock
// sync engine. Owns the rooms/{code} document. Consumes PlaybackClock ONLY via
// its public API (currentTime/duration/rate/playing/state/play/pause/seek/
// setRate/on) — the <audio> element stays private to PlaybackClock.
// No DOM, no three.js.

import {
  db,
  doc,
  collection,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
} from './FirebaseClient.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1
const CODE_LENGTH = 6;
const CONCERT_ID = 'motown25-billiejean';
const MAX_PLAYERS = 4;
const DRIFT_TOLERANCE = 0.120; // seconds
const ANCHOR_DEBOUNCE_MS = 200;
const HOST_HEARTBEAT_MS = 5000;
const SESSION_STALE_MS = 15000;
const GUEST_DRIFT_INTERVAL_MS = 2000;

/** @returns {string} a random room code from the safe alphabet. */
function mintCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

/** Default transport block for a fresh lobby room (paused, no anchor progress). */
function defaultTransport() {
  return {
    playing: false,
    rate: 1,
    muted: false,
    lightingPreset: 'single-spot',
    cameraForced: false,
    abLoop: null,
    anchor: {
      audioPositionAtAnchor: 0,
      anchorServerTime: serverTimestamp(),
      seq: 0,
    },
  };
}

export class Room {
  /**
   * Use the static factories `Room.create` / `Room.join`; the constructor is
   * internal.
   * @private
   */
  constructor({ database, code, playerId, isHost }) {
    this._db = database;
    /** @type {string} 6-char room code (also the room doc id). */
    this.code = code;
    /** @type {string} this client's playerId (per-tab UUID). */
    this.playerId = playerId;
    /** @type {boolean} true for the room creator only (no migration). */
    this.isHost = isHost;
    /** @type {'lobby'|'performing'|'ended'} last known room state. */
    this.state = 'lobby';

    // --- wiring set up lazily by attachClock/heartbeat ---
    this._clock = null;
    this._clockSync = null;
    this._roomRef = doc(database, 'rooms', code);
    this._unsubRoom = null;
    this._clockUnsubs = [];
    this._anchorTimer = null;
    this._guestDriftTimer = null;
    this._hostHeartbeatTimer = null;
    this._seq = 0;
    this._lastAppliedSeq = -1;
    this._sessionEnded = false;

    // --- Phase 4: A-B loop (host), reset/kick/lighting tracking (guest) ---
    this._lastAbLoop = null;      // host sticky mirror of transport.abLoop
    this._abLoopCooldown = 0;     // host re-entrancy guard for loop seek
    this._presence = null;        // attached via attachPresence() for tidy-up
    this._lastResetSeq = null;    // guest: last seen resetSeatsSeq (null = unseen)
    this._lastLightingSeen = undefined; // guest: last seen lightingPreset
    this._kickedEmitted = false;  // guest: latch so 'kicked' fires once

    // --- tiny event emitter ('roomchange','transportapplied','sessionended') ---
    this._listeners = new Map();

    // Bound leave handler for pagehide.
    this._onPageHide = () => this.leave();
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this._onPageHide);
    }
  }

  // ============================================================
  // Static factories
  // ============================================================

  /**
   * Create a new room as host. Mints a unique code via transaction (retrying on
   * collision), writes the room doc + the host's player doc.
   * @param {{db:any, name:string}} opts
   * @returns {Promise<Room>} a Room in host mode.
   */
  static async create({ db: database, name }) {
    const playerId = crypto.randomUUID();
    let code = null;

    for (let attempt = 0; attempt < 8 && !code; attempt++) {
      const candidate = mintCode();
      const ref = doc(database, 'rooms', candidate);
      try {
        await runTransaction(database, async (tx) => {
          const snap = await tx.get(ref);
          if (snap.exists()) throw new Error('collision');
          tx.set(ref, {
            code: candidate,
            hostId: playerId,
            concertId: CONCERT_ID,
            state: 'lobby',
            maxPlayers: MAX_PLAYERS,
            createdAt: serverTimestamp(),
            hostHeartbeat: serverTimestamp(),
            transport: defaultTransport(),
            resetSeatsSeq: 0,
            kicked: {},
          });
        });
        code = candidate;
      } catch (err) {
        if (err && err.message === 'collision') continue;
        throw err;
      }
    }
    if (!code) throw new Error('[Room] failed to mint a unique room code');

    // Host player doc.
    const playerRef = doc(database, 'rooms', code, 'players', playerId);
    await setDoc(playerRef, {
      id: playerId,
      name: String(name || 'Host').trim().slice(0, 16) || 'Host',
      isHost: true,
      joinedAt: serverTimestamp(),
      ready: false,
      pos: { x: 0, y: 1.7, z: 12 },
      yaw: Math.PI,
      lastSeen: serverTimestamp(),
    });

    return new Room({ database, code, playerId, isHost: true });
  }

  /**
   * Join an existing room as guest. Transaction rejects if the room is missing,
   * not in lobby, or already full; otherwise creates this client's player doc.
   * @param {{db:any, code:string, name:string}} opts
   * @returns {Promise<Room>} a Room in guest mode.
   */
  static async join({ db: database, code, name }) {
    const normCode = String(code || '').trim().toUpperCase();
    const playerId = crypto.randomUUID();
    const roomRef = doc(database, 'rooms', normCode);
    const playerRef = doc(database, 'rooms', normCode, 'players', playerId);
    const playersCol = collection(database, 'rooms', normCode, 'players');

    // Firestore transactions cannot range-read a subcollection, so capacity is
    // enforced with a getDocs pre-count. This is a room-code watch-party (open
    // rules, max 4) — the tiny race of two simultaneous joiners is acceptable,
    // and the host's removeStale/kick janitor is the backstop.
    await runTransaction(database, async (tx) => {
      const roomSnap = await tx.get(roomRef);
      if (!roomSnap.exists()) throw new Error('Room not found');
      const data = roomSnap.data();
      if (data.state !== 'lobby') throw new Error('Session already started or ended');
      const maxPlayers = data.maxPlayers || MAX_PLAYERS;

      const playersSnap = await getDocs(playersCol);
      if (playersSnap.size >= maxPlayers) throw new Error('Room is full');

      tx.set(playerRef, {
        id: playerId,
        name: String(name || 'Player').trim().slice(0, 16) || 'Player',
        isHost: false,
        joinedAt: serverTimestamp(),
        ready: false,
        pos: { x: 0, y: 1.7, z: 12 },
        yaw: Math.PI,
        lastSeen: serverTimestamp(),
      });
    });

    return new Room({ database, code: normCode, playerId, isHost: false });
  }

  // ============================================================
  // Clock sync engine
  // ============================================================

  /**
   * Wire this room to the local PlaybackClock and ClockSync.
   * HOST: republishes transport + a fresh anchor (debounced 200ms, seq++) on
   *   every clock 'statechange'/'seeked'/'ratechange'.
   * GUEST: subscribes to the room doc, applies play/pause/rate, and reseeks the
   *   local clock when it drifts >120ms from the host-derived expectedPos.
   * @param {import('../PlaybackClock.js').PlaybackClock} clock
   * @param {import('./ClockSync.js').ClockSync} clockSync
   */
  attachClock(clock, clockSync) {
    this._clock = clock;
    this._clockSync = clockSync;

    if (this.isHost) {
      const republish = () => this._scheduleAnchor();
      this._clockUnsubs.push(clock.on('statechange', republish));
      this._clockUnsubs.push(clock.on('seeked', republish));
      this._clockUnsubs.push(clock.on('ratechange', republish));
      // A-B loop enforcement: when the playhead passes B, seek back to A. The
      // seek fires 'seeked' -> normal anchor republish, so guests just follow.
      this._clockUnsubs.push(clock.on('timeupdate', () => {
        const loop = this._lastAbLoop;
        if (!loop) return;
        const now = Date.now();
        if (now < this._abLoopCooldown) return; // one seek per crossing
        if (clock.currentTime >= loop.b) {
          this._abLoopCooldown = now + 300;
          clock.seek(loop.a);
        }
      }));
    } else {
      // Guest: observe the room doc and apply transport.
      this._unsubRoom = onSnapshot(this._roomRef, (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        this._handleRoomSnapshot(data);
      });
      // Periodic drift correction while playing.
      this._guestDriftTimer = setInterval(() => {
        if (this._clock && this._clock.playing && this._lastTransport) {
          this._applyDrift(this._lastTransport);
        }
      }, GUEST_DRIFT_INTERVAL_MS);
    }
  }

  /** @private HOST: debounce transport writes so rapid clock events coalesce. */
  _scheduleAnchor() {
    if (!this.isHost) return;
    if (this._anchorTimer) clearTimeout(this._anchorTimer);
    this._anchorTimer = setTimeout(() => {
      this._anchorTimer = null;
      this._writeTransport({});
    }, ANCHOR_DEBOUNCE_MS);
  }

  /**
   * @private HOST: write the current transport with a fresh anchor + seq++.
   * @param {object} extra additional transport-field overrides to merge.
   */
  async _writeTransport(extra = {}) {
    if (!this.isHost || !this._clock) return;
    this._seq += 1;
    const transport = {
      playing: this._clock.playing,
      rate: this._clock.rate,
      muted: false, // mute is per-client local now; field kept for doc shape only
      lightingPreset: this._lastLighting || 'single-spot',
      cameraForced: this._lastCameraForced || false,
      abLoop: this._lastAbLoop || null,
      ...extra,
      anchor: {
        audioPositionAtAnchor: this._clock.currentTime,
        anchorServerTime: serverTimestamp(),
        seq: this._seq,
      },
    };
    // Keep local mirrors of sticky fields.
    this._lastLighting = transport.lightingPreset;
    this._lastCameraForced = transport.cameraForced;
    this._lastAbLoop = transport.abLoop;
    try {
      await updateDoc(this._roomRef, { transport });
    } catch (err) {
      console.warn('[Room] transport write failed:', err && err.message);
    }
  }

  /** @private GUEST: react to a room-doc snapshot. */
  _handleRoomSnapshot(data) {
    // Session-end detection.
    const wasState = this.state;
    this.state = data.state || 'lobby';
    if (this.state === 'ended' && !this._sessionEnded) {
      this._sessionEnded = true;
      this._emit('sessionended', 'host-ended');
    }
    if (wasState !== this.state) this._emit('roomchange', data);
    this._lastHostHeartbeat = data.hostHeartbeat || null;

    // --- Phase 4 guest reactions (kick / reset-seats / lighting) ---
    // Kick: if the host flagged this player, latch + emit once.
    if (data.kicked && data.kicked[this.playerId] && !this._kickedEmitted) {
      this._kickedEmitted = true;
      this._emit('kicked');
    }
    // Reset-to-seats: monotonic seq. Ignore the first observation at join.
    if (typeof data.resetSeatsSeq === 'number') {
      if (this._lastResetSeq === null) {
        this._lastResetSeq = data.resetSeatsSeq;
      } else if (data.resetSeatsSeq > this._lastResetSeq) {
        this._lastResetSeq = data.resetSeatsSeq;
        this._emit('resetseats');
      }
    }
    // Lighting preset: emit on change; also emit once on first snapshot so late
    // joiners pick up the current preset.
    const preset = data.transport && data.transport.lightingPreset;
    if (preset && preset !== this._lastLightingSeen) {
      this._lastLightingSeen = preset;
      this._emit('lightingchange', preset);
    }

    const t = data.transport;
    if (!t || !t.anchor) return;

    // Ignore stale anchors.
    if (typeof t.anchor.seq === 'number' && t.anchor.seq <= this._lastAppliedSeq) {
      // Still keep latest for periodic drift use (rate/playing may be same seq).
      this._lastTransport = t;
      return;
    }
    this._lastAppliedSeq = t.anchor.seq;
    this._lastTransport = t;

    // Apply rate.
    if (this._clock && Math.abs(this._clock.rate - t.rate) > 1e-3) {
      this._clock.setRate(t.rate);
    }
    // Apply play/pause.
    if (this._clock) {
      if (t.playing && !this._clock.playing) {
        this._applyDrift(t); // seek before playing so we start aligned
        this._clock.play();
      } else if (!t.playing && this._clock.playing) {
        this._clock.pause();
        this._applyDrift(t);
      } else {
        this._applyDrift(t);
      }
    }
    this._emit('transportapplied', t);
  }

  /** @private GUEST: reseek local clock if drift beyond tolerance. */
  _applyDrift(t) {
    if (!this._clock || !this._clockSync || !t || !t.anchor) return;
    const anchorMs = t.anchor.anchorServerTime && t.anchor.anchorServerTime.toMillis
      ? t.anchor.anchorServerTime.toMillis()
      : null;
    if (anchorMs == null) return; // serverTimestamp not resolved yet

    let expectedPos;
    if (t.playing) {
      const elapsed = (this._clockSync.syncedNowMs() - anchorMs) / 1000;
      expectedPos = t.anchor.audioPositionAtAnchor + elapsed * t.rate;
    } else {
      expectedPos = t.anchor.audioPositionAtAnchor;
    }
    const drift = Math.abs(this._clock.currentTime - expectedPos);
    if (drift > DRIFT_TOLERANCE) {
      this._clock.seek(expectedPos);
    }
  }

  // ============================================================
  // Host-only transport helpers
  // ============================================================

  /**
   * Host-only: patch sticky transport fields (muted/lightingPreset/
   * cameraForced/state) with a fresh anchor. Guests never call this.
   * @param {{muted?:boolean, lightingPreset?:string, cameraForced?:boolean, state?:string}} patch
   */
  async setTransportField(patch = {}) {
    if (!this.isHost) return;
    const { state, ...transportPatch } = patch;
    if (state) {
      this.state = state;
      try { await updateDoc(this._roomRef, { state }); }
      catch (err) { console.warn('[Room] state write failed:', err && err.message); }
    }
    if (Object.keys(transportPatch).length) {
      await this._writeTransport(transportPatch);
    }
  }

  /**
   * Host-only: begin the performance — state:'performing', cameraForced:true,
   * playing:true, plus a fresh anchor, in one update. Also starts the local
   * clock so the host's own audio plays.
   */
  async startPerformance() {
    if (!this.isHost || !this._clock) return;
    this.state = 'performing';
    this._seq += 1;
    this._lastCameraForced = true;
    // Start local playback first so currentTime is meaningful in the anchor.
    await this._clock.play();
    const transport = {
      playing: true,
      rate: this._clock.rate,
      muted: false,
      lightingPreset: this._lastLighting || 'single-spot',
      cameraForced: true,
      abLoop: this._lastAbLoop || null,
      anchor: {
        audioPositionAtAnchor: this._clock.currentTime,
        anchorServerTime: serverTimestamp(),
        seq: this._seq,
      },
    };
    try {
      await updateDoc(this._roomRef, { state: 'performing', transport });
    } catch (err) {
      console.warn('[Room] startPerformance failed:', err && err.message);
    }
  }

  /**
   * Host-only: stop the performance — pause, drop cameraForced, back to lobby
   * so players can free-walk again between runs.
   */
  async stopPerformance() {
    if (!this.isHost || !this._clock) return;
    this.state = 'lobby';
    this._clock.pause();
    this._lastCameraForced = false;
    await this.setTransportField({ state: 'lobby', cameraForced: false });
  }

  // ============================================================
  // Host-only Phase 4 controls (lighting / A-B loop / reset / kick)
  // ============================================================

  /**
   * Host-only: set the synced lighting preset. Drives Lighting.applyPreset on
   * guests via the 'lightingchange' event derived from transport.lightingPreset.
   * @param {'single-spot'|'full-stage'|'blackout'} preset
   */
  setLightingPreset(preset) {
    if (!this.isHost) return;
    return this.setTransportField({ lightingPreset: preset });
  }

  /**
   * Host-only: define the A-B loop window (seconds of audio time). Invariant
   * 0 <= a < b <= duration; invalid input is a no-op. Sticky in the room doc;
   * enforced host-side (see attachClock 'timeupdate').
   * @param {number} a loop start (s)
   * @param {number} b loop end (s)
   */
  setAbLoop(a, b) {
    if (!this.isHost) return;
    const dur = this._clock && typeof this._clock.duration === 'number'
      ? this._clock.duration : Infinity;
    if (!(typeof a === 'number' && typeof b === 'number')) return;
    if (!(a >= 0 && a < b && b <= dur)) {
      console.warn('[Room] setAbLoop rejected invalid window', a, b, 'dur', dur);
      return;
    }
    this._lastAbLoop = { a, b };
    return this._writeTransport({ abLoop: { a, b } });
  }

  /** Host-only: clear the A-B loop. */
  clearAbLoop() {
    if (!this.isHost) return;
    this._lastAbLoop = null;
    return this._writeTransport({ abLoop: null });
  }

  /**
   * Host-only: signal all guests (and the host UI) to snap players back to
   * their seats. Monotonic counter so repeated resets always fire; no
   * reset-to-false write needed. increment isn't re-exported from
   * FirebaseClient, so this is a read-modify-write.
   */
  async resetPlayersToSeats() {
    if (!this.isHost) return;
    try {
      const snap = await getDoc(this._roomRef);
      const cur = (snap.exists() && typeof snap.data().resetSeatsSeq === 'number')
        ? snap.data().resetSeatsSeq : 0;
      await updateDoc(this._roomRef, { resetSeatsSeq: cur + 1 });
    } catch (err) {
      console.warn('[Room] resetPlayersToSeats failed:', err && err.message);
    }
  }

  /**
   * Host-only: kick a player. Marks kicked.{id}=true (so the target self-exits)
   * then best-effort deletes their player doc. playerIds are per-tab UUIDs, so
   * this is a kick, not a ban — a kicked player can rejoin with a fresh id;
   * acceptable for a 4-friend watch-party.
   * @param {string} playerId
   */
  async kickPlayer(playerId) {
    if (!this.isHost || !playerId || playerId === this.playerId) return;
    try {
      await updateDoc(this._roomRef, { ['kicked.' + playerId]: true });
    } catch (err) {
      console.warn('[Room] kickPlayer flag failed:', err && err.message);
    }
    try {
      const playerRef = doc(this._db, 'rooms', this.code, 'players', playerId);
      await deleteDoc(playerRef);
    } catch (_) { /* best effort */ }
  }

  /**
   * Attach the Presence instance (both roles) so leave() can tidy up its
   * heartbeat + snapshot subscription (Phase-3 leak fix).
   * @param {import('./Presence.js').Presence} presence
   */
  attachPresence(presence) {
    this._presence = presence;
  }

  /**
   * Host-only: start rewriting hostHeartbeat every 5s so guests can detect a
   * dead host. Call once after create().
   */
  startHostHeartbeat() {
    if (!this.isHost) return;
    this.stopHostHeartbeat();
    const beat = () => {
      updateDoc(this._roomRef, { hostHeartbeat: serverTimestamp() })
        .catch((err) => console.warn('[Room] heartbeat failed:', err && err.message));
    };
    beat();
    this._hostHeartbeatTimer = setInterval(beat, HOST_HEARTBEAT_MS);
  }

  /** Stop the host heartbeat interval. */
  stopHostHeartbeat() {
    if (this._hostHeartbeatTimer) {
      clearInterval(this._hostHeartbeatTimer);
      this._hostHeartbeatTimer = null;
    }
  }

  // ============================================================
  // Guest session-end watchdog
  // ============================================================

  /**
   * Guest-only: invoke cb once when the session ends — either room.state
   * becomes 'ended', or the host heartbeat goes >15s stale in synced time.
   * @param {() => void} cb
   */
  onSessionEnded(cb) {
    this.on('sessionended', cb);
    // Heartbeat-staleness watchdog (the reliable fallback when the host tab
    // dies without writing state:'ended').
    if (this._staleTimer) clearInterval(this._staleTimer);
    this._staleTimer = setInterval(() => {
      if (this._sessionEnded) return;
      const hb = this._lastHostHeartbeat;
      if (hb && hb.toMillis && this._clockSync) {
        const age = this._clockSync.syncedNowMs() - hb.toMillis();
        if (age > SESSION_STALE_MS) {
          this._sessionEnded = true;
          this._emit('sessionended', 'host-stale');
        }
      }
    }, HOST_HEARTBEAT_MS);
  }

  // ============================================================
  // Teardown
  // ============================================================

  /**
   * Leave the room. Guest: delete own player doc. Host: set state:'ended' then
   * delete own player doc. Best-effort (also wired to 'pagehide').
   */
  leave() {
    if (this._left) return;
    this._left = true;
    const playerRef = doc(this._db, 'rooms', this.code, 'players', this.playerId);
    if (this.isHost) {
      updateDoc(this._roomRef, { state: 'ended' }).catch(() => {});
    }
    deleteDoc(playerRef).catch(() => {});
    this._teardownTimers();
    // Phase-3 tidy-up: kill the ClockSync auto-recalibrate timer (+ ping docs)
    // and the Presence heartbeat + snapshot sub, which previously leaked.
    try { this._clockSync?.stop?.(); } catch (_) {}
    try { this._presence?.stop?.(); } catch (_) {}
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this._onPageHide);
    }
  }

  /** @private clear all intervals/subscriptions. */
  _teardownTimers() {
    this.stopHostHeartbeat();
    if (this._unsubRoom) { this._unsubRoom(); this._unsubRoom = null; }
    for (const un of this._clockUnsubs) { try { un(); } catch (_) {} }
    this._clockUnsubs = [];
    if (this._anchorTimer) { clearTimeout(this._anchorTimer); this._anchorTimer = null; }
    if (this._guestDriftTimer) { clearInterval(this._guestDriftTimer); this._guestDriftTimer = null; }
    if (this._staleTimer) { clearInterval(this._staleTimer); this._staleTimer = null; }
  }

  // ============================================================
  // Tiny event emitter
  // ============================================================

  /**
   * Subscribe to a room event: 'roomchange' | 'transportapplied' |
   * 'sessionended' | 'lightingchange' (payload: preset string) | 'resetseats'
   * (no payload) | 'kicked' (no payload).
   * @param {string} event
   * @param {(payload:any)=>void} cb
   * @returns {() => void} unsubscribe.
   */
  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(cb);
    return () => {
      const set = this._listeners.get(event);
      if (set) set.delete(cb);
    };
  }

  /** @private */
  _emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try { cb(payload); } catch (err) { console.error(`[Room] listener '${event}' error:`, err); }
    }
  }
}
