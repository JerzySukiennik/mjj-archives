// js/ConcertLoader.js — fetches concert.json, validates it against the schema
// (schemaVersion 1), resolves relative asset paths against the manifest URL, and
// returns a typed manifest object. Optional-not-yet-produced assets are literal
// null and pass through as null (never resolved).

const REQUIRED_STRINGS = ['name', 'audio', 'model', 'hall'];
const NULLABLE_PATHS = ['motion', 'cameraTrack', 'markers'];

/**
 * @param {string} manifestUrl URL (absolute or relative to document) of concert.json.
 * @returns {Promise<object>} typed manifest with resolved absolute asset URLs.
 * @throws {Error} with a human-readable message on any validation failure.
 */
export async function loadConcert(manifestUrl) {
  const absManifestUrl = new URL(manifestUrl, window.location.href).href;

  let res;
  try {
    res = await fetch(absManifestUrl, { cache: 'no-cache' });
  } catch (err) {
    throw new Error(`Could not fetch manifest (${manifestUrl}): ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`Manifest fetch failed: HTTP ${res.status} for ${manifestUrl}`);
  }

  let raw;
  try {
    raw = await res.json();
  } catch (err) {
    throw new Error(`Manifest is not valid JSON (${manifestUrl}): ${err.message}`);
  }

  // --- schemaVersion ---
  if (typeof raw.schemaVersion !== 'number') {
    throw new Error('Manifest missing required number field "schemaVersion".');
  }
  if (raw.schemaVersion !== 1) {
    throw new Error(`Unsupported schemaVersion ${raw.schemaVersion} (expected 1).`);
  }

  // --- required strings ---
  for (const key of REQUIRED_STRINGS) {
    if (typeof raw[key] !== 'string' || raw[key].length === 0) {
      throw new Error(`Manifest field "${key}" must be a non-empty string.`);
    }
  }

  // --- duration ---
  if (typeof raw.duration !== 'number' || !Number.isFinite(raw.duration) || raw.duration <= 0) {
    throw new Error('Manifest field "duration" must be a positive number.');
  }

  // --- nullable path fields: present + (string | null) ---
  for (const key of NULLABLE_PATHS) {
    if (!(key in raw)) {
      throw new Error(`Manifest must include key "${key}" (use null if unproduced).`);
    }
    if (raw[key] !== null && typeof raw[key] !== 'string') {
      throw new Error(`Manifest field "${key}" must be a string path or null.`);
    }
  }

  const resolve = (p) => (p == null ? null : new URL(p, absManifestUrl).href);

  // Typed manifest. Unknown extra keys are intentionally ignored.
  return {
    schemaVersion: raw.schemaVersion,
    name: raw.name,
    hall: raw.hall,
    duration: raw.duration,
    manifestUrl: absManifestUrl,
    audio: resolve(raw.audio),
    model: resolve(raw.model),
    motion: resolve(raw.motion),
    cameraTrack: resolve(raw.cameraTrack),
    markers: resolve(raw.markers),
  };
}
