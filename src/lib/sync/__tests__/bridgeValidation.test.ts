import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BRIDGE_PORT,
  MIN_BRIDGE_TIMEOUT_MS,
  MAX_BRIDGE_TIMEOUT_MS,
  parseBridgePort,
  clampBridgeTimeout,
} from '../bridgeValidation';

describe('bridgeValidation', () => {
  describe('parseBridgePort', () => {
    it('defaults to 4401 when null, undefined, or empty', () => {
      expect(parseBridgePort(null)).toBe(DEFAULT_BRIDGE_PORT);
      expect(parseBridgePort(undefined)).toBe(DEFAULT_BRIDGE_PORT);
      expect(parseBridgePort('')).toBe(DEFAULT_BRIDGE_PORT);
      expect(parseBridgePort('   ')).toBe(DEFAULT_BRIDGE_PORT);
    });

    it('accepts valid integer ports in 1024..65535', () => {
      expect(parseBridgePort(4401)).toBe(4401);
      expect(parseBridgePort('1024')).toBe(1024);
      expect(parseBridgePort('65535')).toBe(65535);
      expect(parseBridgePort(' 8443 ')).toBe(8443);
    });

    it('rejects SSRF / authority injection payloads', () => {
      expect(parseBridgePort('4401@attacker.com/x#')).toBeNull();
      expect(parseBridgePort('4401/internal#')).toBeNull();
      expect(parseBridgePort('4401?foo=bar')).toBeNull();
      expect(parseBridgePort('localhost:4401')).toBeNull();
    });

    it('rejects privileged, out-of-range, or non-integer ports', () => {
      expect(parseBridgePort(80)).toBeNull();
      expect(parseBridgePort('443')).toBeNull();
      expect(parseBridgePort('1023')).toBeNull();
      expect(parseBridgePort('65536')).toBeNull();
      expect(parseBridgePort(4401.5)).toBeNull();
      expect(parseBridgePort(-4401)).toBeNull();
      expect(parseBridgePort('abc')).toBeNull();
    });
  });

  describe('clampBridgeTimeout', () => {
    it('falls back to defaultMs when missing or invalid', () => {
      expect(clampBridgeTimeout(undefined, 8000)).toBe(8000);
      expect(clampBridgeTimeout('not-a-number', 5000)).toBe(5000);
      expect(clampBridgeTimeout(-100, 8000)).toBe(8000);
    });

    it('clamps values to MIN..MAX bounds', () => {
      expect(clampBridgeTimeout(50)).toBe(MIN_BRIDGE_TIMEOUT_MS);
      expect(clampBridgeTimeout(99999999)).toBe(MAX_BRIDGE_TIMEOUT_MS);
      expect(clampBridgeTimeout(12345.6)).toBe(12346);
    });
  });
});
