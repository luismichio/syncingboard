/**
 * Tauri SyncingBridge Local WebSocket & REST Client
 * Connects to /api/bridge/health or direct local ws://127.0.0.1:4401/ws
 * for 100% zero-cloud local sync.
 */

import { DEFAULT_BRIDGE_PORT, parseBridgePort } from './bridgeValidation';

export type BridgeTransport = 'local' | 'ably-bridge';

export interface TauriBridgeHealth {
  status: string;
  version: string;
  figmaConnected: boolean;
  miroConnected: boolean;
  sessions: number;
  wsUrl: string;
  transport?: BridgeTransport;
}

let resolvedBridgeHost: 'localhost' | '127.0.0.1' = '127.0.0.1';
let activeBridgeTransport: BridgeTransport | null = null;
let lastProbeDiagnostics: string[] = [];

const STORAGE_BRIDGE_TRANSPORT = 'syncingboard_bridge_transport';

export function getActiveBridgeTransport(): BridgeTransport | null {
  if (activeBridgeTransport) return activeBridgeTransport;
  if (typeof window !== 'undefined') {
    try {
      const saved = window.sessionStorage?.getItem(STORAGE_BRIDGE_TRANSPORT);
      if (saved === 'local' || saved === 'ably-bridge') {
        activeBridgeTransport = saved;
        return saved;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export function setActiveBridgeTransport(transport: BridgeTransport | null): void {
  activeBridgeTransport = transport;
  if (typeof window !== 'undefined') {
    try {
      if (transport) {
        window.sessionStorage?.setItem(STORAGE_BRIDGE_TRANSPORT, transport);
      } else {
        window.sessionStorage?.removeItem(STORAGE_BRIDGE_TRANSPORT);
      }
    } catch {
      // ignore
    }
  }
}

export function getLastBridgeProbeDiagnostics(): string[] {
  return [...lastProbeDiagnostics];
}

export function getResolvedBridgeHost(): 'localhost' | '127.0.0.1' {
  return resolvedBridgeHost;
}

export function getConfiguredBridgePort(): string {
  if (typeof window === 'undefined') return String(DEFAULT_BRIDGE_PORT);
  try {
    const saved = window.localStorage?.getItem('syncingboard_bridge_port');
    const valid = parseBridgePort(saved);
    return String(valid ?? DEFAULT_BRIDGE_PORT);
  } catch {
    return String(DEFAULT_BRIDGE_PORT);
  }
}

/**
 * Notifies the local SyncingBridge that Miro/FigJam is linked.
 * Attempts direct loopback HTTP first (for cloud-hosted Next.js) with
 * fallback to the Next.js /api/bridge/connect route.
 */
export async function notifyTauriMiroConnect(): Promise<void> {
  if (typeof window === 'undefined') return;
  const port = getConfiguredBridgePort();
  try {
    const res = await fetch(`http://${resolvedBridgeHost}:${port}/miro/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) return;
  } catch {
    // Fall back to Next.js API proxy
  }

  try {
    const connectUrl = port === '4401' ? '/api/bridge/connect' : `/api/bridge/connect?port=${encodeURIComponent(port)}`;
    await fetch(connectUrl, { method: 'POST' });
  } catch {
    // Ignore notification failure
  }
}

export interface LocalMiroUpdatePayload {
  boardId: string;
  itemId: string;
  fileKey: string;
  nodeId: string;
  nodeName: string;
  width?: number;
  dataUrl: string;
  format?: 'png' | 'svg';
  scale?: number;
  preserveSize?: boolean;
}

/**
 * Uploads an updated image directly to Miro REST API v2 via the local Tauri SyncingBridge
 * (0 Vercel calls, 50 MB body limit). Returns null if the local bridge is unreachable so the
 * caller can cleanly fall back to /api/miro/update-image.
 */
export async function updateMiroImageViaTauri(
  payload: LocalMiroUpdatePayload,
  miroToken: string
): Promise<Response | null> {
  if (typeof window === 'undefined') return null;
  const port = getConfiguredBridgePort();
  try {
    const res = await fetch(`http://${resolvedBridgeHost}:${port}/miro/update-image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${miroToken}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
      cache: 'no-store',
    });
    // 503 means local broker is paused -> fall back to cloud route
    if (res.status === 503) return null;
    return res;
  } catch {
    return null;
  }
}

/**
 * Probes whether the local SyncingBridge broker is actively listening on port 4401 (or configured port).
 * 1. Checks relative /api/bridge/health (seamless within Miro iframe/Next.js backend)
 * 2. Falls back to direct WebSocket ws://127.0.0.1:<port>/ws
 * 3. Falls back to direct HTTP http://127.0.0.1:<port>/health
 */
export async function probeTauriBridge(
  timeoutMs = 2000,
  pairingId?: string
): Promise<TauriBridgeHealth | null> {
  if (typeof window === 'undefined') return null;
  const port = getConfiguredBridgePort();
  const diagnostics: string[] = [];
  lastProbeDiagnostics = diagnostics;

  // 1. Primary: relative Next.js backend proxy (/api/bridge/health) — 0 Ably for self-hosted local
  try {
    const healthPath = port === '4401' ? '/api/bridge/health' : `/api/bridge/health?port=${encodeURIComponent(port)}`;
    const res = await fetch(healthPath, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    if (res.ok) {
      const data = (await res.json()) as TauriBridgeHealth;
      if (data && data.status === 'ok') {
        setActiveBridgeTransport('local');
        return { ...data, transport: 'local' };
      }
      diagnostics.push(`${healthPath}: invalid payload`);
    } else {
      diagnostics.push(`${healthPath}: HTTP ${res.status}`);
    }
  } catch (err: unknown) {
    diagnostics.push(`/api/bridge/health: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Secondary: direct WebSocket probe (try localhost first, then 127.0.0.1)
  const hosts: Array<'localhost' | '127.0.0.1'> = ['localhost', '127.0.0.1'];
  if (typeof WebSocket !== 'undefined') {
    for (const host of hosts) {
      const wsEndpoint = `ws://${host}:${port}/ws`;
      const wsResult = await new Promise<TauriBridgeHealth | null>((resolve) => {
        let resolved = false;
        let ws: WebSocket | null = null;

        const cleanup = () => {
          if (ws) {
            try { ws.close(); } catch {}
            ws = null;
          }
        };

        const timer = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            diagnostics.push(`${wsEndpoint}: timeout (${timeoutMs}ms)`);
            cleanup();
            resolve(null);
          }
        }, timeoutMs);

        try {
          ws = new WebSocket(wsEndpoint);

          ws.onopen = () => {
            ws?.send(JSON.stringify({ action: 'health' }));
          };

          ws.onmessage = (ev) => {
            if (resolved) return;
            try {
              const data = JSON.parse(ev.data) as {
                action?: string;
                status?: string;
                version?: string;
                figmaConnected?: boolean;
                miroConnected?: boolean;
                sessions?: number;
                wsUrl?: string;
              };
              if (data.action === 'health-result' || data.status === 'ok') {
                resolved = true;
                clearTimeout(timer);
                cleanup();
                resolvedBridgeHost = host;
                setActiveBridgeTransport('local');
                resolve({
                  status: data.status || 'ok',
                  version: data.version || '0.18.0',
                  figmaConnected: Boolean(data.figmaConnected),
                  miroConnected: Boolean(data.miroConnected),
                  sessions: data.sessions || 0,
                  wsUrl: data.wsUrl || wsEndpoint,
                  transport: 'local',
                });
              }
            } catch {
              // ignore
            }
          };

          ws.onerror = () => {
            if (!resolved) {
              resolved = true;
              diagnostics.push(`${wsEndpoint}: blocked/error`);
              clearTimeout(timer);
              cleanup();
              resolve(null);
            }
          };
        } catch (err: unknown) {
          if (!resolved) {
            resolved = true;
            diagnostics.push(`${wsEndpoint}: ${err instanceof Error ? err.message : String(err)}`);
            clearTimeout(timer);
            cleanup();
            resolve(null);
          }
        }
      });

      if (wsResult) return wsResult;
    }
  }

  // 3. Tertiary: direct HTTP probe (try localhost first, then 127.0.0.1)
  for (const host of hosts) {
    const httpEndpoint = `http://${host}:${port}/health`;
    try {
      const res = await fetch(httpEndpoint, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        resolvedBridgeHost = host;
        setActiveBridgeTransport('local');
        const data = (await res.json()) as TauriBridgeHealth;
        return { ...data, transport: 'local' };
      }
      diagnostics.push(`${httpEndpoint}: HTTP ${res.status}`);
    } catch (err: unknown) {
      diagnostics.push(`${httpEndpoint}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4. Hosted Cloud Control Channel fallback (works in Miro Desktop / Chrome / Safari on syncingboard.com)
  if (pairingId) {
    try {
      const { sendAblyBridgeCommand } = await import('./companionRelayClient');
      const resp = await sendAblyBridgeCommand<{
        ok?: boolean;
        status?: string;
        version?: string;
        figmaConnected?: boolean;
        miroConnected?: boolean;
        sessions?: number;
      }>(pairingId, { type: 'health' }, Math.max(timeoutMs, 2500));
      if (resp && (resp.ok || resp.status === 'ok')) {
        setActiveBridgeTransport('ably-bridge');
        return {
          status: resp.status || 'ok',
          version: resp.version || '0.18.0',
          figmaConnected: Boolean(resp.figmaConnected),
          miroConnected: Boolean(resp.miroConnected),
          sessions: resp.sessions || 1,
          wsUrl: 'ably-bridge',
          transport: 'ably-bridge',
        };
      }
      diagnostics.push(`ably-bridge(figma:${pairingId}): no ok response`);
    } catch (err: unknown) {
      diagnostics.push(
        `ably-bridge(figma:${pairingId}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  setActiveBridgeTransport(null);
  return null;
}

/**
 * Creates a local WebSocket relay connection to the SyncingBridge.
 */
export class TauriLocalRelayConnection {
  private ws: WebSocket | null = null;
  private pairingId: string;
  private onMessageCallback: ((event: string, payload: unknown) => void) | null = null;
  private isClosed = false;

  constructor(pairingId: string) {
    this.pairingId = pairingId;
  }

  public connect(onMessage: (event: string, payload: unknown) => void): Promise<boolean> {
    this.onMessageCallback = onMessage;
    this.isClosed = false;

    return new Promise((resolve) => {
      try {
        const port = getConfiguredBridgePort();
        const wsUrl = `ws://${resolvedBridgeHost}:${port}/ws`;
        const socket = new WebSocket(wsUrl);

        const timeout = setTimeout(() => {
          if (socket.readyState !== WebSocket.OPEN) {
            socket.close();
            resolve(false);
          }
        }, 2000);

        socket.onopen = () => {
          clearTimeout(timeout);
          this.ws = socket;
          // Register pairing channel
          socket.send(JSON.stringify({
            action: 'register',
            pairing_id: this.pairingId,
            role: 'target',
            payload: { role: 'target' },
          }));
          resolve(true);
        };

        socket.onmessage = (ev) => {
          try {
            if (typeof ev.data === 'string') {
              const data = JSON.parse(ev.data) as {
                action?: string;
                event?: string;
                payload?: unknown;
              };
              if (data.event && this.onMessageCallback) {
                this.onMessageCallback(data.event, data.payload);
              }
            }
          } catch {
            // Ignore malformed WS frames
          }
        };

        socket.onerror = () => {
          clearTimeout(timeout);
          resolve(false);
        };

        socket.onclose = () => {
          this.ws = null;
        };
      } catch {
        resolve(false);
      }
    });
  }

  public send(event: string, payload: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.ws.send(JSON.stringify({
      action: 'broadcast',
      pairing_id: this.pairingId,
      event,
      payload,
    }));
    return true;
  }

  public disconnect(): void {
    this.isClosed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  public get isConnected(): boolean {
    return !this.isClosed && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
