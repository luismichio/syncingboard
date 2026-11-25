/**
 * Strict validation helpers for local SyncingBridge (Tauri) loopback requests.
 * Prevents SSRF / URL authority injection (e.g. "4401@attacker.com") and
 * unclamped serverless timeouts.
 */

export const DEFAULT_BRIDGE_PORT = 4401;
export const MIN_BRIDGE_PORT = 1024;
export const MAX_BRIDGE_PORT = 65535;
export const MIN_BRIDGE_TIMEOUT_MS = 1000;
export const MAX_BRIDGE_TIMEOUT_MS = 30000;

/**
 * Parses and strictly validates a TCP port for local SyncingBridge loopback calls.
 * - Returns DEFAULT_BRIDGE_PORT (4401) when raw is null, undefined, or empty string.
 * - Returns null when raw is malformed or outside 1024..65535.
 */
export function parseBridgePort(raw: unknown): number | null {
  if (raw === null || raw === undefined) return DEFAULT_BRIDGE_PORT;

  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < MIN_BRIDGE_PORT || raw > MAX_BRIDGE_PORT) {
      return null;
    }
    return raw;
  }

  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (trimmed === '') return DEFAULT_BRIDGE_PORT;
  if (!/^\d{4,5}$/.test(trimmed)) return null;

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < MIN_BRIDGE_PORT || parsed > MAX_BRIDGE_PORT) {
    return null;
  }

  return parsed;
}

/**
 * Clamps a requested timeout in milliseconds to a safe range (1000..30000).
 */
export function clampBridgeTimeout(raw: unknown, defaultMs = 8000): number {
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(num) || num <= 0) {
    return Math.min(MAX_BRIDGE_TIMEOUT_MS, Math.max(MIN_BRIDGE_TIMEOUT_MS, defaultMs));
  }
  return Math.min(MAX_BRIDGE_TIMEOUT_MS, Math.max(MIN_BRIDGE_TIMEOUT_MS, Math.round(num)));
}
