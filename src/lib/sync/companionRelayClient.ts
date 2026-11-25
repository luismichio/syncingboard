import Ably from 'ably';
import { getOrCreatePairingId } from '@/lib/sync/pairingId';
import { decodeHtmlEntities } from '@/lib/decodeHtmlEntities';
import {
  ablyTokenCacheKey,
  getCachedAblyToken,
  invalidateAblyToken,
  invalidateAllAblyTokens,
  setCachedAblyToken,
} from '@/lib/ablyTokenCache';
import { getActiveBridgeTransport } from '@/lib/sync/tauriBridgeClient';

export interface PenpotMcpResponse {
  content: { type: string; text?: string; data?: string; mimeType?: string; name?: string; width?: number; height?: number }[];
  isError?: boolean;
}

export type RelayJson = null | boolean | number | string | RelayJson[] | { [key: string]: RelayJson };

export interface RelayRequestBody {
  pairingId: string;
  platform?: 'figma' | 'penpot';
  action: 'select' | 'export';
  fileKey?: string;
  shapeId?: string;
  format?: 'svg' | 'png';
  scale?: number;
  timeoutMs?: number;
}

export { getOrCreatePairingId };

let globalAblyClient: Ably.Realtime | null = null;
let globalAblyChannel: Ably.RealtimeChannel | null = null;
let currentConnectedPairingId: string | null = null;
let currentConnectedPlatform: 'figma' | 'penpot' | null = null;
let activeRelayCalls = 0;
let relayKeepAlive = false;
let liveSubscriptionCount = 0;
let idleCloseTimer: ReturnType<typeof setTimeout> | null = null;
let sessionHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let relaySessionId: string | null = null;
let relayUserIdHash: string | null = null;
let relayBoardId: string | null = null;

export function setRelayIdentity(userIdHash: string | null, boardId: string | null): void {
  relayUserIdHash = userIdHash;
  relayBoardId = boardId;
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const RELAY_IDLE_CLOSE_MS = 30_000;
const RELAY_SESSION_HEARTBEAT_MS = 15 * 60_000;

function clearIdleCloseTimer(): void {
  if (idleCloseTimer) {
    clearTimeout(idleCloseTimer);
    idleCloseTimer = null;
  }
}

function getRelaySessionId(): string {
  if (!relaySessionId) {
    relaySessionId = generateSessionId();
  }
  return relaySessionId;
}

/**
 * UUID v4 that does not assume crypto.randomUUID: the Figma/FigJam plugin
 * embed (and older embedded WebViews) expose crypto.getRandomValues but not
 * randomUUID. Mirrors the fallback the companion UIs use for their tab ids.
 */
export function generateSessionId(): string {
  const cryptoObj =
    typeof globalThis !== 'undefined'
      ? (globalThis as typeof globalThis & { crypto?: Crypto }).crypto
      : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    try {
      return cryptoObj.randomUUID();
    } catch {
      // Fall through to the manual build.
    }
  }
  const bytes = new Uint8Array(16);
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    try {
      cryptoObj.getRandomValues(bytes);
    } catch {
      // Fall through to Math.random.
    }
  }
  for (let i = 0; i < 16; i++) {
    if (bytes[i] === 0) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stopSessionHeartbeat(): void {
  if (sessionHeartbeatTimer) {
    clearInterval(sessionHeartbeatTimer);
    sessionHeartbeatTimer = null;
  }
}

type RelayConflictHandler = (conflict: { activeBoardId: string }) => void;
let relayConflictHandler: RelayConflictHandler | null = null;

export type RelayConnectionState = 'idle' | 'connecting' | 'connected';
type RelayConnectionStateHandler = (state: RelayConnectionState) => void;
let relayConnectionState: RelayConnectionState = 'idle';
const relayConnectionStateHandlers = new Set<RelayConnectionStateHandler>();

function setRelayConnectionState(state: RelayConnectionState): void {
  if (relayConnectionState === state) return;
  relayConnectionState = state;
  for (const handler of relayConnectionStateHandlers) handler(state);
}

/**
 * Subscribe to the Miro relay client's connection state so the Import tab can
 * surface "not connected" vs "connected" honestly — a slot is only held while
 * the Ably websocket is live.
 */
export function onRelayConnectionState(handler: RelayConnectionStateHandler): () => void {
  relayConnectionStateHandlers.add(handler);
  return () => {
    relayConnectionStateHandlers.delete(handler);
  };
}

export function onRelayConflict(handler: RelayConflictHandler | null): void {
  relayConflictHandler = handler;
}
type RelayActivityHandler = () => void;
const relayActivityHandlers = new Set<RelayActivityHandler>();
/**
 * R1: notify subscribers (the status banner) after each relay op so the
 * capacity readout refreshes on demand instead of on a blind interval.
 */
export function onRelayActivity(handler: RelayActivityHandler): () => void {
  relayActivityHandlers.add(handler);
  return () => {
    relayActivityHandlers.delete(handler);
  };
}
function notifyRelayActivity(): void {
  for (const handler of relayActivityHandlers) handler();
}

function sendRelaySessionSignal(action: 'heartbeat' | 'release' | 'transfer'): void {
  if (!relaySessionId || typeof window === 'undefined') return;
  const body: Record<string, string> = { sessionId: relaySessionId, action };
  if (relayUserIdHash) body.userIdHash = relayUserIdHash;
  if (relayBoardId) body.boardId = relayBoardId;
  void fetch('/api/relay/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: action === 'release',
  })
    .then(async (response) => {
      if (action !== 'heartbeat') return;
      if (response.status === 429) {
        closeGlobalAblyConnection();
        return;
      }
      if (response.status === 200) {
        const data = (await response.json().catch(() => null)) as
          | { conflict?: boolean; activeBoardId?: string }
          | null;
        if (data?.conflict) {
          relayConflictHandler?.({ activeBoardId: data.activeBoardId ?? '' });
        }
      }
    })
    .catch(() => {
      // A transient heartbeat failure is retried on the next interval.
    });
}

export function releaseLocalRelaySession(): void {
  const hadClient = Boolean(globalAblyClient);
  closeGlobalAblyConnection();
  if (!hadClient) {
    void sendRelaySessionSignal('release');
  }
}

export function heartbeatRelaySession(): void {
  void sendRelaySessionSignal('heartbeat');
}

function startSessionHeartbeat(): void {
  stopSessionHeartbeat();
  sessionHeartbeatTimer = setInterval(() => {
    sendRelaySessionSignal('heartbeat');
  }, RELAY_SESSION_HEARTBEAT_MS);
}

function closeGlobalAblyConnection(): void {
  setRelayConnectionState('idle');
  clearIdleCloseTimer();
  stopSessionHeartbeat();
  const client = globalAblyClient;
  // Clear the singleton first so a synchronous Ably `closed` callback cannot
  // recursively attempt to close the same client.
  globalAblyClient = null;
  globalAblyChannel = null;
  currentConnectedPairingId = null;
  currentConnectedPlatform = null;
  if (client) {
    sendRelaySessionSignal('release');
    try {
      client.close();
    } catch {
      // Ignore stale close errors.
    }
  }
}

export function refreshRelayConnection(): void {
  setRelayConnectionState('idle');
  clearIdleCloseTimer();
  stopSessionHeartbeat();
  const client = globalAblyClient;
  // Clear the singleton first so a synchronous Ably `closed` callback cannot
  // recursively attempt to close the same client.
  globalAblyClient = null;
  globalAblyChannel = null;
  currentConnectedPairingId = null;
  currentConnectedPlatform = null;
  invalidateAllAblyTokens();
  if (client) {
    try {
      client.close();
    } catch {
      // Ignore stale close errors.
    }
  }
}

function scheduleIdleClose(): void {
  clearIdleCloseTimer();
  // A live subscription (M3 relay-pull) pins the connection open even when
  // no request/response is in flight.
  if (relayKeepAlive || activeRelayCalls > 0 || !globalAblyClient) return;
  idleCloseTimer = setTimeout(() => {
    if (activeRelayCalls === 0) closeGlobalAblyConnection();
  }, RELAY_IDLE_CLOSE_MS);
}

function invalidateConnection(client: Ably.Realtime): void {
  if (globalAblyClient !== client) return;
  closeGlobalAblyConnection();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', closeGlobalAblyConnection, { once: true });
}

async function getAblyConnection(
  pairingId: string,
  platform: 'figma' | 'penpot' = 'penpot'
): Promise<Ably.RealtimeChannel> {
  clearIdleCloseTimer();
  const prefix = platform === 'figma' ? 'figma' : 'penpot';

  if (
    globalAblyClient &&
    globalAblyChannel &&
    currentConnectedPairingId === pairingId &&
    currentConnectedPlatform === platform
  ) {
    return globalAblyChannel;
  }

  closeGlobalAblyConnection();

    const identityQuery =
      relayUserIdHash && relayBoardId
        ? '&userIdHash=' + encodeURIComponent(relayUserIdHash) + '&boardId=' + encodeURIComponent(relayBoardId)
        : '';
  setRelayConnectionState('connecting');
  const sessionId = getRelaySessionId();
  const cacheKey = ablyTokenCacheKey(pairingId, platform, sessionId);
  let tokenDetails = getCachedAblyToken(cacheKey);
  if (!tokenDetails) {
    // R5: fetch once per 2h token per session; conflicts/capacity invalidate.
    const tokenUrl =
      '/api/ably/token?pairingId=' + encodeURIComponent(pairingId) +
      '&platform=' + platform + '&client=miro&sessionId=' + encodeURIComponent(sessionId) +
      identityQuery;
    const tokenResponse = await fetch(tokenUrl, { cache: 'no-store' });
    if (tokenResponse.status === 409) {
      invalidateAblyToken(cacheKey);
      const conflictPayload = (await tokenResponse.json().catch(() => ({}))) as {
        activeBoardId?: string;
      };
      relayConflictHandler?.({ activeBoardId: conflictPayload.activeBoardId ?? '' });
      throw new Error('relay_conflict');
    }
    if (!tokenResponse.ok) {
      invalidateAblyToken(cacheKey);
      const errorPayload = (await tokenResponse.json().catch(() => ({}))) as {
        error?: string;
      };
      const message =
        errorPayload.error === 'relay_capacity_reached'
          ? 'Community relay is at full capacity. Wait, then use the status banner to check again.'
          : errorPayload.error || `Ably token request failed with HTTP ${tokenResponse.status}`;
      throw new Error(message);
    }
    tokenDetails = (await tokenResponse.json()) as Record<string, unknown>;
    setCachedAblyToken(cacheKey, tokenDetails);
  }
  globalAblyClient = new Ably.Realtime({
    token: tokenDetails as unknown as Ably.TokenDetails,
  });

  globalAblyChannel = globalAblyClient.channels.get(`${prefix}:${pairingId}`);
  currentConnectedPairingId = pairingId;
  currentConnectedPlatform = platform;
  const client = globalAblyClient;
  client.connection.on('connected', () => setRelayConnectionState('connected'));
  client.connection.on('disconnected', () => setRelayConnectionState('connecting'));
  client.connection.on('failed', () => invalidateConnection(client));
  client.connection.on('suspended', () => invalidateConnection(client));
  client.connection.on('closed', () => invalidateConnection(client));

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Ably connection timed out.')), 10000);

    client.connection.once('connected', () => {
      clearTimeout(timeout);
      resolve();
    });

    client.connection.once('failed', (state) => {
      clearTimeout(timeout);
      reject(new Error(state.reason?.message || 'Ably connection failed'));
    });
  });

  startSessionHeartbeat();
  return globalAblyChannel;
}

/**
 * M3 relay-pull: subscribe to live events the source companion publishes on
 * its pairing channel (e.g. the Figma design companion pushing the current
 * selection). The Miro-role token is subscribe-only, so the mirror listens
 * without ever registering as a source in presence.
 *
 * The subscription keeps the Ably connection alive (skips the idle close)
 * until the returned cleanup is called.
 */
export async function subscribeRelayLive(
  pairingId: string,
  platform: 'figma' | 'penpot',
  eventName: string,
  handler: (data: Record<string, unknown>) => void
): Promise<() => void> {
  const isTauriMode = typeof window !== 'undefined' && localStorage.getItem('syncingboard_use_tauri') === 'true';

  // Penpot runs in the browser sandbox (Chrome LNA blocks loopback), so only Figma routes via local Tauri.
  // When SyncingBridge is linked via the Ably Control Channel ('ably-bridge'), fall through to Ably below.
  if (isTauriMode && platform !== 'penpot' && getActiveBridgeTransport() !== 'ably-bridge') {
    let ws: WebSocket | null = null;
    let sse: EventSource | null = null;
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const port = (typeof window !== 'undefined' && localStorage.getItem('syncingboard_bridge_port')) || '4401';

    const openDirectSocket = () => {
      if (!active || typeof WebSocket === 'undefined') return;
      try {
        const socket = new WebSocket(`ws://localhost:${port}/ws`);
        ws = socket;
        socket.onopen = () => {
          if (!active) {
            try { socket.close(); } catch {}
            return;
          }
          socket.send(JSON.stringify({
            action: 'register',
            pairing_id: pairingId,
            role: 'target',
          }));
        };
        socket.onmessage = (ev) => {
          if (!active) return;
          try {
            const raw = typeof ev.data === 'string' ? JSON.parse(ev.data) : null;
            if (raw && (raw.event === eventName || raw.action === eventName) && raw.payload) {
              handler(raw.payload as Record<string, unknown>);
            }
          } catch {}
        };
        socket.onclose = () => {
          if (ws === socket) ws = null;
          if (active) {
            retryTimer = setTimeout(openPrimary, 3000);
          }
        };
        socket.onerror = () => {
          try { socket.close(); } catch {}
        };
      } catch {
        if (active) {
          retryTimer = setTimeout(openPrimary, 3000);
        }
      }
    };

    const openPrimary = () => {
      if (!active) return;
      // 1. Primary: same-origin SSE proxy (/api/bridge/stream) — matches /api/bridge/health & /api/bridge/relay
      if (typeof EventSource !== 'undefined') {
        let didOpen = false;
        try {
          const streamUrl = `/api/bridge/stream?pairingId=${encodeURIComponent(pairingId)}&event=${encodeURIComponent(eventName)}&port=${encodeURIComponent(port)}`;
          const es = new EventSource(streamUrl);
          sse = es;
          es.onopen = () => {
            didOpen = true;
          };
          es.onmessage = (ev) => {
            if (!active) return;
            try {
              const payload = JSON.parse(ev.data) as Record<string, unknown>;
              if (payload && typeof payload === 'object') {
                handler(payload);
              }
            } catch {
              // ignore malformed SSE payloads
            }
          };
          es.onerror = () => {
            es.close();
            if (sse === es) sse = null;
            if (!active) return;
            if (!didOpen && typeof WebSocket !== 'undefined') {
              // On hosted Vercel (where /api/bridge/stream can't reach 127.0.0.1), fall back to direct WS
              openDirectSocket();
            } else {
              retryTimer = setTimeout(openPrimary, 3000);
            }
          };
          return;
        } catch {
          // Fall through to direct WebSocket
        }
      }

      // 2. Secondary: direct loopback WebSocket
      openDirectSocket();
    };

    openPrimary();

    return () => {
      active = false;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (ws) {
        ws.onclose = null;
        try { ws.close(); } catch {}
        ws = null;
      }
      if (sse) {
        sse.close();
        sse = null;
      }
    };
  }

  const channel = await getAblyConnection(pairingId, platform);
  liveSubscriptionCount += 1;
  relayKeepAlive = true;
  let active = true;
  const listener = (msg: Ably.Message): void => {
    if (!active) return;
    const data = msg.data;
    if (data && typeof data === 'object') {
      handler(data as Record<string, unknown>);
    }
  };
  try {
    await channel.subscribe(eventName, listener);
  } catch (err: unknown) {
    liveSubscriptionCount = Math.max(0, liveSubscriptionCount - 1);
    if (liveSubscriptionCount === 0) {
      relayKeepAlive = false;
      scheduleIdleClose();
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    active = false;
    try {
      void channel.unsubscribe(eventName, listener);
    } catch {
      // Ignore detach races.
    }
    liveSubscriptionCount = Math.max(0, liveSubscriptionCount - 1);
    if (liveSubscriptionCount === 0) {
      relayKeepAlive = false;
      scheduleIdleClose();
    }
  };
}

async function callLocalTauriRelay(body: RelayRequestBody): Promise<RelayJson> {
  const port = (typeof window !== 'undefined' && localStorage.getItem('syncingboard_bridge_port')) || '4401';
  // 1. Primary: relative Next.js backend proxy (/api/bridge/relay)
  try {
    const res = await fetch('/api/bridge/relay', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bridge-port': port,
      },
      body: JSON.stringify({ ...body, port }),
      signal: AbortSignal.timeout(body.timeoutMs || 8000),
      cache: 'no-store',
    });
    if (res.ok) {
      const payload = (await res.json()) as { ok?: boolean; data?: RelayJson };
      if (payload && payload.data !== undefined) {
        return payload.data;
      }
    } else {
      const errData = (await res.json().catch(() => ({}))) as { error?: string };
      if (errData.error) {
        throw new Error(errData.error);
      }
    }
  } catch (err: unknown) {
    if (typeof WebSocket === 'undefined') {
      throw err;
    }
  }

  // 2. Direct WebSocket fallback
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const reqId = 'req_' + Math.random().toString(36).slice(2, 9);
  const timeoutMs = body.timeoutMs || 8000;

  return new Promise<RelayJson>((resolve, reject) => {
    let resolved = false;

    const cleanup = () => {
      resolved = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      clearTimeout(timer);
    };

    const timer = setTimeout(() => {
      if (!resolved) {
        cleanup();
        reject(new Error(`Local Bridge request timed out after ${timeoutMs / 1000}s.`));
      }
    }, timeoutMs);

    ws.onopen = () => {
      // 1. Register channel
      ws.send(JSON.stringify({
        action: 'register',
        pairing_id: body.pairingId,
        role: 'target',
      }));

      // 2. Broadcast command to companion
      ws.send(JSON.stringify({
        action: 'broadcast',
        pairing_id: body.pairingId,
        event: 'command',
        payload: {
          id: reqId,
          action: body.action,
          fileKey: body.fileKey,
          format: body.format,
          scale: body.scale,
          shapeId: body.shapeId,
          client: 'miro',
        },
      }));
    };

    ws.onmessage = (ev) => {
      if (resolved) return;
      try {
        const raw = typeof ev.data === 'string' ? JSON.parse(ev.data) : null;
        if (!raw) return;

        // Handle broadcasted result event from companion
        if ((raw.event === 'result' || raw.action === 'result') && raw.payload) {
          const payload = raw.payload as { id?: string; requestId?: string; data?: RelayJson; error?: string };
          const responseId = payload.id || payload.requestId;
          if (!responseId || responseId === reqId) {
            cleanup();
            if (payload.error) {
              reject(new Error(payload.error));
            } else {
              resolve(payload.data ?? (payload as unknown as RelayJson));
            }
          }
        }
      } catch {
        // ignore
      }
    };

    ws.onerror = () => {
      if (!resolved) {
        cleanup();
        reject(new Error('Local Bridge WebSocket connection failed.'));
      }
    };
  });
}

export interface LocalFigmaExportResult {
  dataUrl: string;
  name?: string;
  width?: number;
  height?: number;
}

/**
 * Exports a Figma node locally via the Figma Companion plugin's `node.exportAsync()`
 * over the Tauri SyncingBridge (0 Figma REST API calls, 0 Ably, 0 Vercel).
 * Returns null if Tauri is disabled, unreachable, or the node is not in the currently open Figma file.
 */
export async function exportFigmaNodeLocally(
  pairingId: string,
  opts: { fileKey?: string; nodeId: string; format: 'png' | 'svg'; scale: number }
): Promise<LocalFigmaExportResult | null> {
  if (typeof window === 'undefined' || !pairingId) return null;
  if (localStorage.getItem('syncingboard_use_tauri') !== 'true') return null;

  try {
    const res = await callLocalTauriRelay({
      pairingId,
      platform: 'figma',
      action: 'export',
      fileKey: opts.fileKey,
      shapeId: opts.nodeId,
      format: opts.format,
      scale: opts.scale,
      timeoutMs: 15_000,
    });
    if (res && typeof res === 'object' && !Array.isArray(res)) {
      const obj = res as Record<string, unknown>;
      if (typeof obj.dataUrl === 'string' && obj.dataUrl.startsWith('data:')) {
        return {
          dataUrl: obj.dataUrl,
          name: typeof obj.name === 'string' ? obj.name : undefined,
          width: typeof obj.width === 'number' ? obj.width : undefined,
          height: typeof obj.height === 'number' ? obj.height : undefined,
        };
      }
    }
    return null;
  } catch {
    // Node not in open file, companion offline, or bridge unreachable -> caller falls back to Figma REST API
    return null;
  }
}

export async function callRelay(body: RelayRequestBody): Promise<RelayJson> {
  const isTauriMode = typeof window !== 'undefined' && localStorage.getItem('syncingboard_use_tauri') === 'true';

  // Hybrid dual-transport: Figma routes via local Tauri SyncingBridge when enabled,
  // while Penpot always uses Ably Cloud Relay (avoiding Chrome LNA blocks & cross-talk).
  if (isTauriMode && body.platform !== 'penpot') {
    if (getActiveBridgeTransport() === 'ably-bridge' && body.action === 'select') {
      const resp = await sendAblyBridgeCommand<{ ok?: boolean; data?: RelayJson; error?: string }>(
        body.pairingId,
        { type: 'select' },
        body.timeoutMs ?? 10_000
      );
      if (!resp.ok) {
        throw new Error(resp.error || 'SyncingBridge select failed');
      }
      return (resp.data ?? {}) as RelayJson;
    }
    if (typeof WebSocket !== 'undefined') {
      try {
        return await callLocalTauriRelay(body);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const isBridgeConnectionFailure =
          msg.includes('Local Bridge WebSocket connection failed') ||
          msg.includes('Failed to connect to local SyncingBridge') ||
          msg.includes('SyncingBridge is unreachable');
        if (!isBridgeConnectionFailure) {
          throw err;
        }
        // Transient fallback to Ably Cloud Relay for this call without clearing
        // the user's syncingboard_use_tauri preference (so Tauri auto-resumes on restart).
      }
    }
  }

  activeRelayCalls += 1;
  clearIdleCloseTimer();
  try {
    const pairingId = body.pairingId;
    const platform = body.platform || 'penpot';
    const channel = await getAblyConnection(pairingId, platform);
    return await new Promise<RelayJson>((resolve, reject) => {
    let resolved = false;
    let targetRequestId: string | null = null;
    const earlyResults = new Map<string, Record<string, unknown>>();

    const cleanup = () => {
      resolved = true;
      try {
        channel.unsubscribe('result', onResult);
        channel.unsubscribe('result-ready', onResultReady);
      } catch {
        // ignore
      }
      clearTimeout(timeout);
    };

    const processResultData = (msgData: Record<string, unknown>) => {
      cleanup();
      if (msgData.error) {
        reject(new Error(String(msgData.error)));
      } else {
        resolve((msgData.data as RelayJson) ?? null);
      }
    };

    const onResult = (msg: Ably.Message) => {
      const msgData = msg.data as Record<string, unknown> | null;
      const reqId = typeof msgData?.requestId === 'string' ? msgData.requestId : null;
      if (!reqId || !msgData) return;

      if (targetRequestId && reqId === targetRequestId) {
        processResultData(msgData);
      } else {
        earlyResults.set(reqId, msgData);
      }
    };

    const onResultReady = async (msg: Ably.Message) => {
      const msgData = msg.data as Record<string, unknown> | null;
      const reqId = typeof msgData?.requestId === 'string' ? msgData.requestId : null;
      if (!reqId || !targetRequestId || reqId !== targetRequestId) return;

      cleanup();
      try {
        let fetchRes: Response | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          fetchRes = await fetch(`/api/relay/response?requestId=${targetRequestId}`);
          if (fetchRes.ok || fetchRes.status !== 404 || attempt === 2) break;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        if (!fetchRes || !fetchRes.ok) {
          const errData = await fetchRes?.json().catch(() => ({})) as { error?: string };
          throw new Error(errData.error || `HTTP ${fetchRes?.status ?? 0}`);
        }
        const fetchPayload = await fetchRes.json() as { data?: RelayJson };
        resolve(fetchPayload.data ?? null);
      } catch (fetchErr: unknown) {
        const errorMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        reject(new Error(`Failed to retrieve relay response: ${errorMsg}`));
      }
    };

    const timeout = setTimeout(() => {
      if (resolved) return;
      cleanup();
      reject(new Error('Relay timed out waiting for companion response.'));
    }, body.timeoutMs || 10000);

    channel.subscribe('result', onResult);
    channel.subscribe('result-ready', onResultReady);

    fetch('/api/relay/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...body,
        async: true,
      }),
    })
      .then(async (res) => {
        const payload = (await res.json().catch(() => ({}))) as { error?: string; data?: { requestId: string } };
        if (!res.ok || payload.error || !payload.data?.requestId) {
          throw new Error(payload.error || `Relay request failed with HTTP ${res.status}`);
        }

        targetRequestId = payload.data.requestId;

        if (earlyResults.has(targetRequestId)) {
          const early = earlyResults.get(targetRequestId);
          if (early) {
            processResultData(early);
          }
        }
      })
      .catch((err: unknown) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  } finally {
    activeRelayCalls = Math.max(0, activeRelayCalls - 1);
    scheduleIdleClose();
    notifyRelayActivity();
  }
}

/**
 * Penpot bridge abstraction:
 * - Cloud relay mode (default), routed through /api/relay/* endpoints.
 */
export async function callPenpotMcpTool(
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<PenpotMcpResponse> {
  if (typeof window === 'undefined') {
    throw new Error('Window context is required.');
  }

  const pairingId = getOrCreatePairingId();

  if (toolName === 'export_shape') {
    const shapeId = toolArgs.shapeId as string;
    const format = (toolArgs.format as 'svg' | 'png' | undefined) ?? 'svg';
    const scale = (toolArgs.scale as number | undefined) ?? 1;

    if (!shapeId) {
      throw new Error('shapeId is required for export_shape.');
    }

    const data = await callRelay({
      pairingId,
      platform: 'penpot',
      action: 'export',
      shapeId,
      format,
      scale,
      timeoutMs: 120_000,
    });

    const payload = data as { svg?: string; base64?: string; name?: string; width?: number; height?: number } | null;
    const decodedName = payload?.name ? decodeHtmlEntities(payload.name) : undefined;

    if (format === 'svg') {
      const svgText = payload?.svg;
      if (!svgText) {
        throw new Error('Penpot relay returned empty SVG export data.');
      }

      return {
        content: [{
          type: 'text',
          text: svgText,
          name: decodedName,
          width: payload?.width,
          height: payload?.height,
        }],
      };
    }

    const base64Data = payload?.base64;
    if (!base64Data) {
      throw new Error('Penpot relay returned empty PNG export data.');
    }

    return {
      content: [{
        type: 'image',
        data: base64Data,
        mimeType: 'image/png',
        name: decodedName,
        width: payload?.width,
        height: payload?.height,
      }],
    };
  }

  throw new Error(`Tool "${toolName}" is not supported.`);
}

/**
 * Broadcasts sync progress and status notifications to the local SyncingBridge
 * and companion plugins for real-time visibility.
 */
export async function sendAblyBridgeCommand<T extends Record<string, unknown>>(
  pairingId: string,
  command: Record<string, unknown>,
  timeoutMs = 15_000
): Promise<T> {
  const channel = await getAblyConnection(pairingId, 'figma');
  const requestId = `br_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
  activeRelayCalls++;
  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const onResp = (msg: Ably.Message) => {
        if (settled || !msg.data || typeof msg.data !== 'object') return;
        const payload = msg.data as Record<string, unknown>;
        if (payload.requestId !== requestId) return;
        settled = true;
        clearTimeout(timer);
        channel.unsubscribe('bridge-resp', onResp);
        resolve(payload as T);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        channel.unsubscribe('bridge-resp', onResp);
        reject(new Error(`SyncingBridge Ably command timed out (${timeoutMs}ms)`));
      }, timeoutMs);

      void channel
        .subscribe('bridge-resp', onResp)
        .then(() => channel.publish('bridge-cmd', { requestId, ...command }))
        .catch((err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          channel.unsubscribe('bridge-resp', onResp);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  } finally {
    activeRelayCalls = Math.max(0, activeRelayCalls - 1);
    scheduleIdleClose();
  }
}

export async function broadcastSyncActivity(pairingId: string, message: string): Promise<void> {
  const isTauriMode = typeof window !== 'undefined' && localStorage.getItem('syncingboard_use_tauri') === 'true';
  if (!pairingId || !isTauriMode) return;
  const port = (typeof window !== 'undefined' && localStorage.getItem('syncingboard_bridge_port')) || '4401';

  try {
    const res = await fetch('/api/bridge/relay', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bridge-port': port,
      },
      body: JSON.stringify({
        pairingId,
        port,
        action: 'sync-event',
        message,
      }),
      cache: 'no-store',
    });
    if (res.ok) return;
  } catch {
    // Fall through to direct WebSocket broadcast
  }

  if (typeof WebSocket !== 'undefined') {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.onopen = () => {
        ws.send(JSON.stringify({
          action: 'broadcast',
          pairing_id: pairingId,
          event: 'sync-event',
          payload: { message },
        }));
        ws.close();
      };
    } catch {
      // Ignore notification failures
    }
  }
}

/**
 * Moves the per-user session binding to THIS board (1 active board per Miro
 * user). On success the Ably client is re-established under the same tab
 * sessionId — now a valid lease — WITHOUT sending a release signal (a plain
 * close would delete the lease we just granted).
 */
export async function transferRelaySession(): Promise<{ granted: boolean; activeSessions: number }> {
  const sessionId = getRelaySessionId();
  if (!relayUserIdHash || !relayBoardId) {
    throw new Error('Relay identity is not ready yet. Try again in a moment.');
  }
  const response = await fetch('/api/relay/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      action: 'transfer',
      userIdHash: relayUserIdHash,
      boardId: relayBoardId,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    granted?: boolean;
    activeSessions?: number;
    error?: string;
    conflict?: boolean;
    activeBoardId?: string;
  };
  if (!response.ok || !payload.granted) {
    if (payload.conflict) {
      throw new Error('Session is still active on the other board.');
    }
    throw new Error(payload.error || 'Transfer failed with HTTP ' + response.status);
  }
  refreshRelayConnection();
  return { granted: true, activeSessions: payload.activeSessions ?? 0 };
}