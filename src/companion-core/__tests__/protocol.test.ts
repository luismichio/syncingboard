import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isHostMessage,
  isRelayCommand,
  isRelayCompanionEvent,
  encodeSelectionStream,
  encodeRelayResult,
  PendingRequestManager,
} from '../protocol';

describe('Companion Protocol Codecs & Guards', () => {
  describe('isHostMessage', () => {
    it('recognizes valid host messages', () => {
      expect(isHostMessage({ action: 'ui-ready' })).toBe(true);
      expect(isHostMessage({ action: 'theme-change', theme: 'light' })).toBe(true);
      expect(isHostMessage({ action: 'selection-changed-locally', data: { id: '1:2' } })).toBe(true);
      expect(isHostMessage({ action: 'selection-result', requestId: 'req_1', data: null })).toBe(true);
      expect(isHostMessage({ action: 'export-result', requestId: 'req_2', data: null })).toBe(true);
    });

    it('rejects invalid or unknown messages', () => {
      expect(isHostMessage(null)).toBe(false);
      expect(isHostMessage({})).toBe(false);
      expect(isHostMessage({ action: 'unknown-action' })).toBe(false);
      expect(isHostMessage('string-payload')).toBe(false);
    });
  });

  describe('isRelayCommand', () => {
    it('recognizes valid relay commands from Miro', () => {
      expect(isRelayCommand({ id: 'cmd_1', action: 'select' })).toBe(true);
      expect(isRelayCommand({ id: 'cmd_2', action: 'export' })).toBe(true);
    });

    it('rejects malformed relay commands', () => {
      expect(isRelayCommand({ id: 'cmd_1' })).toBe(false);
      expect(isRelayCommand({ action: 'select' })).toBe(false);
      expect(isRelayCommand(null)).toBe(false);
    });
  });

  describe('isRelayCompanionEvent', () => {
    it('recognizes companion transfer and eviction events', () => {
      expect(
        isRelayCompanionEvent({ event: 'companion_transferred', tabId: 'tab_abc' })
      ).toBe(true);
      expect(
        isRelayCompanionEvent({ event: 'companion_evicted', tabId: 'tab_xyz' })
      ).toBe(true);
    });

    it('rejects invalid companion events', () => {
      expect(isRelayCompanionEvent({ event: 'unknown', tabId: 'tab_1' })).toBe(false);
      expect(isRelayCompanionEvent({ event: 'companion_evicted' })).toBe(false);
      expect(isRelayCompanionEvent(null)).toBe(false);
    });
  });

  describe('encodeSelectionStream & encodeRelayResult', () => {
    it('encodes selection streaming payloads correctly', () => {
      const stream = encodeSelectionStream('Frame 1', '10:20', 'file_abc');
      expect(stream.name).toBe('Frame 1');
      expect(stream.id).toBe('10:20');
      expect(stream.fileKey).toBe('file_abc');
      expect(typeof stream.ts).toBe('number');
    });

    it('encodes result payloads with optional error and pairingId', () => {
      const res1 = encodeRelayResult('req_1', { id: '1:2', name: 'Header' }, null, 'sb_pair1');
      expect(res1.requestId).toBe('req_1');
      expect(res1.data?.name).toBe('Header');
      expect(res1.error).toBeNull();
      expect(res1.pairingId).toBe('sb_pair1');

      const res2 = encodeRelayResult('req_2', null, 'Failed to render');
      expect(res2.requestId).toBe('req_2');
      expect(res2.data).toBeNull();
      expect(res2.error).toBe('Failed to render');
    });
  });

  describe('PendingRequestManager', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('tracks and takes pending requests within TTL', () => {
      const manager = new PendingRequestManager(5000);
      manager.track('req_100');
      expect(manager.has('req_100')).toBe(true);
      expect(manager.size()).toBe(1);

      const item = manager.take('req_100');
      expect(item?.id).toBe('req_100');
      expect(manager.has('req_100')).toBe(false);
      expect(manager.size()).toBe(0);
    });

    it('expires pending requests after timeout', () => {
      const onExpire = vi.fn();
      const manager = new PendingRequestManager(3000, onExpire);

      manager.track('req_timeout');
      expect(manager.has('req_timeout')).toBe(true);

      vi.advanceTimersByTime(3500);

      expect(manager.has('req_timeout')).toBe(false);
      expect(onExpire).toHaveBeenCalledWith('req_timeout');
    });
  });
});
