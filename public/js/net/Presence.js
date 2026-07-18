// js/net/Presence.js — player presence: pose broadcast, ready-check, heartbeat,
// and a host-side janitor that prunes stale player docs. Owns
// rooms/{code}/players/{playerId}. ALL writes are fire-and-forget — never
// awaited in the render path; errors are caught + console.warn'd.
// No DOM, no three.js.

import {
  db,
  doc,
  collection,
  setDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
} from './FirebaseClient.js';

const POSE_MIN_INTERVAL_MS = 200; // ~5Hz cap
const POSE_MIN_MOVE = 0.05;       // metres
const POSE_MIN_TURN = (3 * Math.PI) / 180; // 3 degrees in radians
const HEARTBEAT_MS = 5000;
const STALE_MS = 15000;

export class Presence {
  /**
   * @param {any} database Firestore instance (usually the shared `db`).
   * @param {string} roomCode room code — players live under rooms/{code}/players.
   * @param {string} playerId this client's playerId (doc id).
   */
  constructor(database, roomCode, playerId) {
    this._db = database || db;
    this._roomCode = roomCode;
    this._playerId = playerId;
    this._playerRef = doc(this._db, 'rooms', roomCode, 'players', playerId);
    this._playersCol = collection(this._db, 'rooms', roomCode, 'players');

    this._lastWriteMs = 0;
    this._lastPos = null;
    this._lastYaw = null;
    this._clockSync = null; // optional, for synced-time staleness
    this._heartbeatTimer = null;
    this._unsub = null;
  }

  /**
   * Optionally supply a ClockSync so removeStale() compares in synced server
   * time. Without it, local Date.now() is used (fine for a rough janitor).
   * @param {import('./ClockSync.js').ClockSync} clockSync
   */
  setClockSync(clockSync) {
    this._clockSync = clockSync;
  }

  /**
   * Mark this player ready (audio+model+scene loaded) or not. Fire-and-forget.
   * @param {boolean} bool
   */
  setReady(bool) {
    updateDoc(this._playerRef, { ready: !!bool, lastSeen: serverTimestamp() })
      .catch((err) => console.warn('[Presence] setReady failed:', err && err.message));
  }

  /**
   * Broadcast avatar pose. Rate-limited to at most one write per 200ms, and
   * skipped entirely when the player moved <5cm AND turned <3°. Piggybacks
   * lastSeen so pose writes double as heartbeats. Fire-and-forget — safe to
   * call every frame.
   * @param {{x:number,y:number,z:number}} pos world position.
   * @param {number} yaw facing direction in radians.
   */
  updatePose(pos, yaw) {
    const now = Date.now();
    if (now - this._lastWriteMs < POSE_MIN_INTERVAL_MS) return;

    if (this._lastPos) {
      const dx = pos.x - this._lastPos.x;
      const dy = pos.y - this._lastPos.y;
      const dz = pos.z - this._lastPos.z;
      const moved = Math.hypot(dx, dy, dz);
      let dyaw = Math.abs(yaw - (this._lastYaw ?? yaw));
      dyaw = Math.min(dyaw, Math.abs(2 * Math.PI - dyaw)); // wrap-around
      if (moved < POSE_MIN_MOVE && dyaw < POSE_MIN_TURN) return;
    }

    this._lastWriteMs = now;
    this._lastPos = { x: pos.x, y: pos.y, z: pos.z };
    this._lastYaw = yaw;

    updateDoc(this._playerRef, {
      pos: { x: pos.x, y: pos.y, z: pos.z },
      yaw,
      lastSeen: serverTimestamp(),
    }).catch((err) => console.warn('[Presence] updatePose failed:', err && err.message));
  }

  /**
   * Subscribe to the players subcollection. cb receives the full array of
   * player docs on every change.
   * @param {(players:Array<object>)=>void} cb
   * @returns {() => void} unsubscribe.
   */
  onPlayers(cb) {
    this._unsub = onSnapshot(this._playersCol, (snap) => {
      const players = [];
      snap.forEach((d) => players.push(d.data()));
      try { cb(players); } catch (err) { console.error('[Presence] onPlayers cb error:', err); }
    });
    return this._unsub;
  }

  /**
   * Start the 5s lastSeen heartbeat. Independent of pose writes so an idle
   * player still stays alive.
   */
  startHeartbeat() {
    this.stopHeartbeat();
    const beat = () => {
      updateDoc(this._playerRef, { lastSeen: serverTimestamp() })
        .catch((err) => console.warn('[Presence] heartbeat failed:', err && err.message));
    };
    beat();
    this._heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
  }

  /** Stop the heartbeat interval. */
  stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /**
   * Host-only janitor: delete player docs whose lastSeen is >15s stale (in
   * synced server time when a ClockSync is attached). Fire-and-forget per doc.
   * Call periodically from the host.
   */
  removeStale() {
    const nowMs = this._clockSync ? this._clockSync.syncedNowMs() : Date.now();
    getDocs(this._playersCol)
      .then((snap) => {
        snap.forEach((d) => {
          const data = d.data();
          if (d.id === this._playerId) return; // never prune self
          const ls = data.lastSeen;
          if (ls && ls.toMillis && nowMs - ls.toMillis() > STALE_MS) {
            deleteDoc(d.ref).catch(() => {});
          }
        });
      })
      .catch((err) => console.warn('[Presence] removeStale failed:', err && err.message));
  }

  /** Stop all subscriptions and timers. */
  stop() {
    this.stopHeartbeat();
    if (this._unsub) { this._unsub(); this._unsub = null; }
  }
}
