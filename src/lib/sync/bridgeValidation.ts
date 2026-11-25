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
 * Static allowlist of loopback origins for server-side /api/bridge/* routes (ports 4401–4410).
 * Using literal constant strings prevents SSRF localhost port-scanning against unrelated services.
 */
const ALLOWED_BRIDGE_HTTP_ORIGINS: Readonly<Record<number, string>> = {
  4401: 'http://127.0.0.1:4401',
  4402: 'http://127.0.0.1:4402',
  4403: 'http://127.0.0.1:4403',
  4404: 'http://127.0.0.1:4404',
  4405: 'http://127.0.0.1:4405',
  4406: 'http://127.0.0.1:4406',
  4407: 'http://127.0.0.1:4407',
  4408: 'http://127.0.0.1:4408',
  4409: 'http://127.0.0.1:4409',
  4410: 'http://127.0.0.1:4410',
};

const ALLOWED_BRIDGE_WS_ORIGINS: Readonly<Record<number, string>> = {
  4401: 'ws://127.0.0.1:4401',
  4402: 'ws://127.0.0.1:4402',
  4403: 'ws://127.0.0.1:4403',
  4404: 'ws://127.0.0.1:4404',
  4405: 'ws://127.0.0.1:4405',
  4406: 'ws://127.0.0.1:4406',
  4407: 'ws://127.0.0.1:4407',
  4408: 'ws://127.0.0.1:4408',
  4409: 'ws://127.0.0.1:4409',
  4410: 'ws://127.0.0.1:4410',
};

export function resolveAllowedBridgeHttpOrigin(port: number): string | null {
  return Object.prototype.hasOwnProperty.call(ALLOWED_BRIDGE_HTTP_ORIGINS, port)
    ? ALLOWED_BRIDGE_HTTP_ORIGINS[port]
    : null;
}

export function resolveAllowedBridgeWsOrigin(port: number): string | null {
  return Object.prototype.hasOwnProperty.call(ALLOWED_BRIDGE_WS_ORIGINS, port)
    ? ALLOWED_BRIDGE_WS_ORIGINS[port]
    : null;
}

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
