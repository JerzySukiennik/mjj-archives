// js/net/ClockSync.js — NTP-style clock offset estimation against Firestore
// serverTimestamp(). Lets every client agree on a shared "server now" so the
// host's transport anchor can be interpreted identically everywhere.
// No DOM, no three.js.

import {
  db,
  collection,
  doc,
  addDoc,
  getDoc,
  deleteDoc,
  serverTimestamp,
} from './FirebaseClient.js';

export class ClockSync {
  /**
   * @param {import('./FirebaseClient.js').db} database Firestore instance (usually the shared `db`).
   * @param {string} roomCode Room code — pings live under rooms/{code}/pings.
   * @param {string} clientId This client's playerId (stamped on ping docs).
   */
  constructor(database, roomCode, clientId) {
    this._db = database || db;
    this._roomCode = roomCode;
    this._clientId = clientId;
    /** @type {number} Estimated (serverNow - localNow) in ms. */
    this._offsetMs = 0;
    this._calibrated = false;
    this._recalTimer = null;
    /** @type {import('firebase/firestore').DocumentReference[]} own ping docs to clean up. */
    this._pingRefs = [];
  }

  /**
   * Run the NTP-style calibration: write N ping docs sequentially, each stamped
   * with serverTimestamp(), read each back, and estimate the offset from the
   * round-trip. Drops the two highest-RTT samples and averages the rest.
   * Safe to call repeatedly (recalibration).
   * @param {number} [samples=5] number of ping round-trips to take.
   * @returns {Promise<number>} the freshly computed offsetMs.
   */
  async calibrate(samples = 5) {
    const pingsCol = collection(this._db, 'rooms', this._roomCode, 'pings');
    /** @type {{offset:number, rtt:number, ref:any}[]} */
    const results = [];

    for (let i = 0; i < samples; i++) {
      try {
        const t0 = Date.now();
        const ref = await addDoc(pingsCol, {
          clientId: this._clientId,
          clientSendMs: t0,
          serverTime: serverTimestamp(),
        });
        this._pingRefs.push(ref);
        const snap = await getDoc(ref);
        const t1 = Date.now();
        const serverTime = snap.get('serverTime');
        if (!serverTime || typeof serverTime.toMillis !== 'function') {
          // serverTimestamp may still be null on immediate readback; skip sample.
          continue;
        }
        const rtt = t1 - t0;
        const offset = serverTime.toMillis() - (t0 + rtt / 2);
        results.push({ offset, rtt, ref });
      } catch (err) {
        console.warn('[ClockSync] calibrate sample failed:', err && err.message);
      }
    }

    if (results.length > 0) {
      // Drop the two highest-RTT samples (keep at least one).
      results.sort((a, b) => a.rtt - b.rtt);
      const keep = results.length > 3 ? results.slice(0, results.length - 2) : results;
      const avg = keep.reduce((s, r) => s + r.offset, 0) / keep.length;
      this._offsetMs = avg;
      this._calibrated = true;
    }

    // Best-effort cleanup of our own ping docs.
    this._cleanupPings();
    return this._offsetMs;
  }

  /**
   * @returns {number} best estimate of the server's "now" in ms since epoch.
   */
  syncedNowMs() {
    return Date.now() + this._offsetMs;
  }

  /** @returns {number} current estimated offset (serverNow - localNow) in ms. */
  get offsetMs() {
    return this._offsetMs;
  }

  /** @returns {boolean} whether at least one calibration has succeeded. */
  get calibrated() {
    return this._calibrated;
  }

  /**
   * Start silent periodic recalibration to correct local clock drift.
   * @param {number} [intervalMs=60000] recalibration period.
   */
  startAutoRecalibrate(intervalMs = 60000) {
    this.stop();
    this._recalTimer = setInterval(() => {
      this.calibrate().catch((err) =>
        console.warn('[ClockSync] auto-recalibrate failed:', err && err.message)
      );
    }, intervalMs);
  }

  /** Stop auto-recalibration and clean up any leftover ping docs. */
  stop() {
    if (this._recalTimer) {
      clearInterval(this._recalTimer);
      this._recalTimer = null;
    }
    this._cleanupPings();
  }

  /** @private best-effort delete of this client's ping docs. */
  _cleanupPings() {
    const refs = this._pingRefs;
    this._pingRefs = [];
    for (const ref of refs) {
      deleteDoc(ref).catch(() => {});
    }
  }
}
