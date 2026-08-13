import { describe, it, expect, vi } from 'vitest';
import {
  calculateReconnectBackoff,
  calculateStandbyBackoff,
  sendSessionAction,
  sendReleaseBeacon,
  CompanionStateMachine,
} from '../session';

describe('Companion Session Lifecycle', () => {
  describe('Backoff Calculations', () => {
    it('calculates exponential reconnect backoff with 16s ceiling', () => {
      expect(calculateReconnectBackoff(1)).toBe(4000);
      expect(calculateReconnectBackoff(2)).toBe(8000);
      expect(calculateReconnectBackoff(3)).toBe(16000);
      expect(calculateReconnectBackoff(4)).toBe(16000);
    });

    it('calculates stepped linear standby backoff up to 60s max', () => {
      expect(calculateStandbyBackoff(1)).toBe(5000);
      expect(calculateStandbyBackoff(3)).toBe(5000);
      expect(calculateStandbyBackoff(4)).toBe(10000);
      expect(calculateStandbyBackoff(6)).toBe(10000);
      expect(calculateStandbyBackoff(7)).toBe(15000);
      expect(calculateStandbyBackoff(30)).toBe(50000);
      expect(calculateStandbyBackoff(40)).toBe(60000);
    });
  });

  describe('Session Actions & Beacons', () => {
    it('dispatches session action POST successfully', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      const success = await sendSessionAction(
        'https://syncingboard.com',
        'sb_123',
        'tab_1',
        'transfer',
        mockFetch as unknown as typeof fetch
      );

      expect(success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://syncingboard.com/api/relay/companion/session',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ pairingId: 'sb_123', tabId: 'tab_1', action: 'transfer' }),
        })
      );
    });

    it('handles sendReleaseBeacon safely', () => {
      const beaconSent = sendReleaseBeacon('https://syncingboard.com', 'sb_123', 'tab_1');
      expect(typeof beaconSent).toBe('boolean');
    });
  });

  describe('CompanionStateMachine', () => {
    it('transitions through session states and notifies listener', () => {
      const stateChanges: Array<{ state: string; status: string; text?: string }> = [];
      const sm = new CompanionStateMachine('tab_test', (state, status, text) => {
        stateChanges.push({ state, status, text });
      });

      expect(sm.getState()).toBe('idle');
      expect(sm.getTabId()).toBe('tab_test');

      sm.startConnecting('sb_123');
      expect(sm.getState()).toBe('connecting');
      expect(sm.getPairingId()).toBe('sb_123');

      sm.setConnected();
      expect(sm.getState()).toBe('connected');

      sm.setStandby();
      expect(sm.getState()).toBe('standby');
      expect(sm.getStandbyAttempts()).toBe(1);

      sm.setConflict();
      expect(sm.getState()).toBe('conflict');

      sm.setTransferred();
      expect(sm.getState()).toBe('transferred');
      expect(sm.getPairingId()).toBe('');

      expect(stateChanges.length).toBeGreaterThanOrEqual(5);
    });
  });
});
