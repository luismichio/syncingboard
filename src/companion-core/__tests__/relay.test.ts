import { describe, it, expect, vi } from 'vitest';
import { getRelayChannelName, canInlinePayload, submitRelayResult } from '../relay';

describe('Companion Relay Channel & Result Publishing', () => {
  describe('getRelayChannelName', () => {
    it('formats platform-prefixed channel names', () => {
      expect(getRelayChannelName('figma', 'sb_123')).toBe('figma:sb_123');
      expect(getRelayChannelName('penpot', 'sb_456')).toBe('penpot:sb_456');
    });
  });

  describe('canInlinePayload', () => {
    it('inlines null, empty, or selection-only payloads', () => {
      expect(canInlinePayload(null)).toBe(true);
      expect(canInlinePayload({ id: '1:2', name: 'Header' })).toBe(true);
    });

    it('rejects base64 from inlining over Ably', () => {
      expect(canInlinePayload({ id: '1:2', base64: 'data:image/png;base64,iVBOR...' })).toBe(
        false
      );
    });

    it('inlines small SVGs but rejects oversized SVGs (>12KB)', () => {
      expect(canInlinePayload({ id: '1:2', svg: '<svg>small</svg>' })).toBe(true);

      const largeSvg = '<svg>' + 'a'.repeat(15000) + '</svg>';
      expect(canInlinePayload({ id: '1:2', svg: largeSvg })).toBe(false);
    });
  });

  describe('submitRelayResult', () => {
    it('publishes inline directly over Ably channel when payload is small', async () => {
      const mockPublish = vi.fn().mockResolvedValue(undefined);
      const res = await submitRelayResult({
        relayUrl: 'https://syncingboard.com',
        pairingId: 'sb_123',
        requestId: 'req_1',
        data: { id: '1:2', name: 'Button' },
        platform: 'figma',
        ablyChannel: { publish: mockPublish },
      });

      expect(res.inlined).toBe(true);
      expect(res.success).toBe(true);
      expect(mockPublish).toHaveBeenCalledWith('result', {
        requestId: 'req_1',
        data: { id: '1:2', name: 'Button' },
        error: null,
      });
    });

    it('falls back to HTTP POST for Penpot heavy export payloads', async () => {
      const mockPublish = vi.fn().mockResolvedValue(undefined);
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      const heavyData = { id: '1:2', base64: 'data:image/png;base64,...' };
      const res = await submitRelayResult({
        relayUrl: 'https://syncingboard.com',
        pairingId: 'sb_123',
        requestId: 'req_2',
        data: heavyData,
        platform: 'penpot',
        ablyChannel: { publish: mockPublish },
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(res.inlined).toBe(false);
      expect(res.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://syncingboard.com/api/relay/penpot/result',
        expect.objectContaining({
          method: 'POST',
        })
      );
      expect(mockPublish).toHaveBeenCalledWith('result-ready', { requestId: 'req_2' });
    });
  });
});
