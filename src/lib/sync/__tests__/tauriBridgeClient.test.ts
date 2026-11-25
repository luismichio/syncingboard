import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getConfiguredBridgePort,
  probeTauriBridge,
  TauriLocalRelayConnection,
} from '../tauriBridgeClient';

describe('tauriBridgeClient', () => {
  const originalFetch = global.fetch;
  const originalLocalStorage = global.localStorage;
  const originalWebSocket = global.WebSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error in unit test'));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    global.localStorage = originalLocalStorage;
    global.WebSocket = originalWebSocket;
  });

  describe('probeTauriBridge', () => {
    it('returns health payload when /api/bridge/health responds with 200', async () => {
      const mockHealth = {
        status: 'ok',
        version: '0.17.2',
        figmaConnected: true,
        miroConnected: true,
        sessions: 1,
        wsUrl: 'ws://127.0.0.1:4401/ws',
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockHealth,
      } as unknown as Response);

      const res = await probeTauriBridge();
      expect(res).toEqual({ ...mockHealth, transport: 'local' });
    });

    it('uses custom port from localStorage when configured', async () => {
      window.localStorage.setItem('syncingboard_bridge_port', '4405');
      expect(getConfiguredBridgePort()).toBe('4405');

      const mockHealth = {
        status: 'ok',
        version: '0.17.2',
        figmaConnected: false,
        miroConnected: true,
        sessions: 1,
        wsUrl: 'ws://127.0.0.1:4405/ws',
      };

      const fetchSpy = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockHealth,
      } as unknown as Response);
      global.fetch = fetchSpy;

      const res = await probeTauriBridge();
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/bridge/health?port=4405',
        expect.any(Object)
      );
      expect(res).toEqual({ ...mockHealth, transport: 'local' });
      window.localStorage.removeItem('syncingboard_bridge_port');
    });

    it('returns health payload when ws://127.0.0.1:4401/ws responds with health-result', async () => {
      const mockHealth = {
        action: 'health-result',
        status: 'ok',
        version: '0.17.2',
        figmaConnected: true,
        miroConnected: true,
        sessions: 1,
        wsUrl: 'ws://127.0.0.1:4401/ws',
      };

      class MockWebSocket {
        public onopen: (() => void) | null = null;
        public onmessage: ((ev: { data: string }) => void) | null = null;
        public onerror: (() => void) | null = null;
        public onclose: (() => void) | null = null;
        public readyState = 1;

        constructor() {
          setTimeout(() => {
            if (this.onopen) this.onopen();
          }, 5);
        }

        public send(_data: string) {
          setTimeout(() => {
            if (this.onmessage) {
              this.onmessage({ data: JSON.stringify(mockHealth) });
            }
          }, 5);
        }

        public close() {
          this.readyState = 3;
        }
      }

      global.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const res = await probeTauriBridge(500);
      expect(res).toEqual({
        status: 'ok',
        version: '0.17.2',
        figmaConnected: true,
        miroConnected: true,
        sessions: 1,
        wsUrl: 'ws://127.0.0.1:4401/ws',
        transport: 'local',
      });
    });

    it('returns null when all probes fail', async () => {
      class ErrorWebSocket {
        public onerror: (() => void) | null = null;
        public onclose: (() => void) | null = null;
        public readyState = 3;

        constructor() {
          setTimeout(() => {
            if (this.onerror) this.onerror();
          }, 5);
        }

        public send() {}
        public close() {}
      }

      global.WebSocket = ErrorWebSocket as unknown as typeof WebSocket;

      const res = await probeTauriBridge(100);
      expect(res).toBeNull();
    });
  });

  describe('TauriLocalRelayConnection', () => {
    it('instantiates and initializes in disconnected state', () => {
      const conn = new TauriLocalRelayConnection('pair-123');
      expect(conn.isConnected).toBe(false);
    });

    it('safely disconnects without error when not open', () => {
      const conn = new TauriLocalRelayConnection('pair-123');
      expect(() => conn.disconnect()).not.toThrow();
      expect(conn.isConnected).toBe(false);
    });

    it('connects, registers target role, broadcasts events, and receives peer messages', async () => {
      const sentFrames: string[] = [];

      class RelayMockWebSocket {
        public static OPEN = 1;
        public static lastInstance: RelayMockWebSocket | null = null;
        public onopen: (() => void) | null = null;
        public onmessage: ((ev: { data: string }) => void) | null = null;
        public onerror: (() => void) | null = null;
        public onclose: (() => void) | null = null;
        public readyState = 1;

        constructor() {
          RelayMockWebSocket.lastInstance = this;
          setTimeout(() => {
            this.onopen?.();
          }, 5);
        }

        public send(data: string) {
          sentFrames.push(data);
        }

        public close() {
          this.readyState = 3;
          this.onclose?.();
        }
      }

      global.WebSocket = RelayMockWebSocket as unknown as typeof WebSocket;

      const conn = new TauriLocalRelayConnection('pair-abc');
      const received: Array<{ event: string; payload: unknown }> = [];
      const connected = await conn.connect((event, payload) => {
        received.push({ event, payload });
      });

      expect(connected).toBe(true);
      expect(conn.isConnected).toBe(true);
      expect(sentFrames.length).toBe(1);

      const regMsg = JSON.parse(sentFrames[0]) as {
        action: string;
        pairing_id: string;
        role: string;
        payload?: { role?: string };
      };
      expect(regMsg.action).toBe('register');
      expect(regMsg.pairing_id).toBe('pair-abc');
      expect(regMsg.role).toBe('target');
      expect(regMsg.payload?.role).toBe('target');

      // Send broadcast command
      const sentOk = conn.send('command', { action: 'select' });
      expect(sentOk).toBe(true);
      expect(sentFrames.length).toBe(2);
      const bcastMsg = JSON.parse(sentFrames[1]) as {
        action: string;
        pairing_id: string;
        event: string;
      };
      expect(bcastMsg.action).toBe('broadcast');
      expect(bcastMsg.event).toBe('command');

      // Receive broadcast message from companion
      RelayMockWebSocket.lastInstance?.onmessage?.({
        data: JSON.stringify({
          action: 'broadcast',
          event: 'selection',
          payload: { id: '1:2', name: 'Hero Frame' },
        }),
      });
      expect(received).toEqual([
        { event: 'selection', payload: { id: '1:2', name: 'Hero Frame' } },
      ]);

      conn.disconnect();
      expect(conn.isConnected).toBe(false);
    });
  });
});
