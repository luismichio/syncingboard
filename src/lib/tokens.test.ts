import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isTokenExpiring, saveToken, getToken, clearToken, getValidToken, TokenData } from './tokens';

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

    it('deduplicates concurrent getValidToken refreshes (single-flight lock for rotating refresh tokens)', async () => {
      const store = new Map<string, string>();
      const mockStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
      };
      Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, configurable: true, writable: true });
      Object.defineProperty(globalThis, 'window', {
        value: {
          location: { origin: 'http://localhost:3000', pathname: '/figjam-mirror' },
        },
        configurable: true,
        writable: true,
      });

      const expiringToken: TokenData = {
        accessToken: 'old_access',
        refreshToken: 'single_use_rt_1',
        expiresAt: 1000000000000 + 60_000, // within 5m buffer
      };
      await saveToken('miro', expiringToken);

      const origFetch = globalThis.fetch;
      const fetchMock = vi.fn<typeof fetch>(async () =>
        new Response(
          JSON.stringify({
            accessToken: 'fresh_access_2',
            refreshToken: 'single_use_rt_2',
            expiresAt: 1000000000000 + 3600_000,
          }),
          { status: 200 }
        )
      );
      globalThis.fetch = fetchMock;

      try {
        const [t1, t2, t3] = await Promise.all([
          getValidToken('miro'),
          getValidToken('miro'),
          getValidToken('miro'),
        ]);
        expect(t1).toBe('fresh_access_2');
        expect(t2).toBe('fresh_access_2');
        expect(t3).toBe('fresh_access_2');
        // All 3 concurrent callers MUST share a single POST /api/oauth/refresh call
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });
});
