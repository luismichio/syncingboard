import { describe, it, expect, vi } from 'vitest';
import {
  buildAblyTokenUrl,
  fetchAblyToken,
  CompanionConflictError,
  CompanionRateLimitError,
  CompanionTokenError,
} from '../token';

describe('Companion Token Lifecycle', () => {
  describe('buildAblyTokenUrl', () => {
    it('constructs correct token URL with query parameters', () => {
      const url = buildAblyTokenUrl('https://syncingboard.com', 'sb_123', 'figma', 'tab_abc');
      expect(url).toBe(
        'https://syncingboard.com/api/ably/token?pairingId=sb_123&platform=figma&tabId=tab_abc'
      );
    });

    it('handles trailing slashes cleanly', () => {
      const url = buildAblyTokenUrl('http://localhost:3000/', 'sb_456', 'penpot', 'tab_xyz');
      expect(url).toBe(
        'http://localhost:3000/api/ably/token?pairingId=sb_456&platform=penpot&tabId=tab_xyz'
      );
    });
  });

  describe('fetchAblyToken', () => {
    it('returns token response on HTTP 200', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({ token: 'mock-ably-jwt', clientId: 'companion:figma' }),
      });

      const res = await fetchAblyToken(
        'https://syncingboard.com',
        'sb_123',
        'figma',
        'tab_1',
        mockFetch as unknown as typeof fetch
      );

      expect(res.token).toBe('mock-ably-jwt');
      expect(res.clientId).toBe('companion:figma');
    });

    it('throws CompanionConflictError on HTTP 409', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 409,
        ok: false,
      });

      await expect(
        fetchAblyToken(
          'https://syncingboard.com',
          'sb_123',
          'figma',
          'tab_1',
          mockFetch as unknown as typeof fetch
        )
      ).rejects.toThrow(CompanionConflictError);
    });

    it('throws CompanionRateLimitError on HTTP 429', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 429,
        ok: false,
        headers: new Headers({ 'Retry-After': '10' }),
      });

      try {
        await fetchAblyToken(
          'https://syncingboard.com',
          'sb_123',
          'figma',
          'tab_1',
          mockFetch as unknown as typeof fetch
        );
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CompanionRateLimitError);
        expect((err as CompanionRateLimitError).retryAfter).toBe(10);
      }
    });

    it('throws CompanionTokenError on HTTP 500', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 500,
        ok: false,
      });

      await expect(
        fetchAblyToken(
          'https://syncingboard.com',
          'sb_123',
          'figma',
          'tab_1',
          mockFetch as unknown as typeof fetch
        )
      ).rejects.toThrow(CompanionTokenError);
    });
  });
});
