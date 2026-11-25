import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isTokenExpiring, saveToken, getToken, clearToken, TokenData } from './tokens';

describe('tokens helper tests', () => {
  beforeEach(() => {
    // Lock date to a fixed timestamp: 1000000000000 (roughly Sep 2001)
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000000000000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isTokenExpiring', () => {
    it('should return true if token is null', () => {
      expect(isTokenExpiring(null)).toBe(true);
    });

    it('should return true if token is already expired', () => {
      const expiredToken: TokenData = {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: 1000000000000 - 1000, // 1s ago
      };
      expect(isTokenExpiring(expiredToken)).toBe(true);
    });

    it('should return true if token is expiring within the 5-minute buffer', () => {
      const buffer = 5 * 60 * 1000;
      const expiringToken: TokenData = {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: 1000000000000 + buffer - 1000, // expiring in 4m 59s
      };
      expect(isTokenExpiring(expiringToken)).toBe(true);
    });

    it('should return false if token is expiring after the 5-minute buffer', () => {
      const buffer = 5 * 60 * 1000;
      const freshToken: TokenData = {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: 1000000000000 + buffer + 1000, // expiring in 5m 1s
      };
      expect(isTokenExpiring(freshToken)).toBe(false);
    });
  });

  describe('github token storage & /figjam-mirror Miro SDK guard', () => {
    const origWindow = globalThis.window;
    const origLocalStorage = globalThis.localStorage;

    afterEach(() => {
      Object.defineProperty(globalThis, 'window', { value: origWindow, configurable: true, writable: true });
      Object.defineProperty(globalThis, 'localStorage', { value: origLocalStorage, configurable: true, writable: true });
    });

    it('saves, reads, and clears github tokens in localStorage without touching Miro storage on /figjam-mirror', async () => {
      const store = new Map<string, string>();
      const mockStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
      };
      const miroGet = vi.fn();
      const miroSet = vi.fn();

      Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, configurable: true, writable: true });
      Object.defineProperty(globalThis, 'window', {
        value: {
          location: { origin: 'http://localhost:3000', pathname: '/figjam-mirror' },
          miro: { board: { storage: { get: miroGet, set: miroSet } } },
        },
        configurable: true,
        writable: true,
      });

      const ghToken: TokenData = {
        accessToken: 'ghu_secret_token',
        refreshToken: '',
        expiresAt: 1000000000000 + 3600_000,
      };

      await saveToken('github', ghToken);
      const loaded = await getToken('github');
      expect(loaded?.accessToken).toBe('ghu_secret_token');
      expect(miroSet).not.toHaveBeenCalled();
      expect(miroGet).not.toHaveBeenCalled();

      await clearToken('github');
      const afterClear = await getToken('github');
      expect(afterClear).toBeNull();
      expect(miroSet).not.toHaveBeenCalled();
    });
  });
});
