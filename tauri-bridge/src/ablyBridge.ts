/**
 * Outbound Ably Control Channel for SyncingBridge.
 *
 * Allows hosted syncingboard.com inside Miro Desktop / Chrome / Safari (where Chromium LNA
 * blocks direct loopback to 127.0.0.1:4401) to send tiny JSON control commands to SyncingBridge,
 * while 100% of Figma exports (exportAsync) and 50 MB Miro image PATCH uploads execute locally
 * in Rust with 0 Figma REST calls, 0 Vercel calls, and 0 Ably image bytes.
 *
 * Idle-zero guarantee:
 * - Only connects to Ably while a local Figma Companion is actively connected AND no local
 *   Miro target is already connected (so self-hosted `yarn local:tauri` uses 0 Ably connections).
 * - Can be disabled completely in Settings ("Cloud Control Channel") for strictly offline setups.
 */

import Ably from 'ably';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

const DEFAULT_API_BASE = 'https://www.syncingboard.com';
const STORAGE_CLOUD_ENABLED = 'syncingboard_cloud_control';
const STORAGE_API_BASE = 'syncingboard_cloud_api_base';
const SELECTION_DEBOUNCE_MS = 400;

interface BridgePairingEvent {
  pairingId?: string | null;
  active: boolean;
  sources?: number;
}

interface BridgeLocalTargetEvent {
  active: boolean;
}

interface BridgeSourceEvent {
  pairingId?: string;
  event: 'selection' | 'hotkey';
  payload?: unknown;
}

interface BridgeCommandPayload {
  requestId: string;
  type: 'health' | 'select' | 'sync-image';
  fileKey?: string;
  nodeId?: string;
  nodeName?: string;
  boardId?: string;
  itemId?: string;
  miroToken?: string;
  format?: 'png' | 'svg';
  scale?: number;
  width?: number;
  preserveSize?: boolean;
}

interface LocalExportResponse {
  id?: string;
  requestId?: string;
  error?: string;
  data?: {
    dataUrl?: string;
    name?: string;
    selection?: unknown;
    fileKey?: string;
  };
  dataUrl?: string;
  name?: string;
}

export function initAblyCloudBridge(): void {
  let ablyClient: Ably.Realtime | null = null;
  let ablyChannel: Ably.RealtimeChannel | null = null;
  let activePairingId: string | null = null;
  let connectedPairingId: string | null = null;
  let hasLocalTarget = false;
  let cloudEnabled = localStorage.getItem(STORAGE_CLOUD_ENABLED) !== 'false';
  let selectionTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSelectionPayload: unknown = null;

  const cloudToggle = document.getElementById('toggle-cloud-control') as HTMLInputElement | null;
  if (cloudToggle) {
    cloudToggle.checked = cloudEnabled;
    cloudToggle.addEventListener('change', () => {
      cloudEnabled = cloudToggle.checked;
      localStorage.setItem(STORAGE_CLOUD_ENABLED, cloudEnabled ? 'true' : 'false');
      void reconcileConnection();
    });
  }

  const getApiBase = (): string => {
    const custom = localStorage.getItem(STORAGE_API_BASE)?.trim();
    if (custom && /^https:\/\/[a-z0-9.-]+$/i.test(custom)) {
      return custom;
    }
    return DEFAULT_API_BASE;
  };

  const logCloud = (message: string): void => {
    void invoke('bridge_log_cloud', { service: 'CloudBridge', message }).catch(() => {});
  };

  const disconnectAbly = (reason?: string): void => {
    if (selectionTimer) {
      clearTimeout(selectionTimer);
      selectionTimer = null;
      pendingSelectionPayload = null;
    }
    const client = ablyClient;
    ablyClient = null;
    ablyChannel = null;
    const prevPairing = connectedPairingId;
    connectedPairingId = null;
    if (client) {
      try {
        client.close();
      } catch {
        // ignore close errors
      }
      void invoke('bridge_set_cloud_miro', { connected: false }).catch(() => {});
      if (reason && prevPairing) {
        logCloud(`Closed Ably control channel (${prevPairing}): ${reason}`);
      }
    }
  };

  const publishResponse = async (
    channel: Ably.RealtimeChannel,
    requestId: string,
    body: Record<string, unknown>
  ): Promise<void> => {
    await channel.publish('bridge-resp', { requestId, ...body });
  };

  const handleBridgeCommand = async (
    channel: Ably.RealtimeChannel,
    pairingId: string,
    cmd: BridgeCommandPayload
  ): Promise<void> => {
    const { requestId, type } = cmd;
    if (!requestId || !type) return;

    if (type === 'health') {
      void invoke('bridge_set_cloud_miro', { connected: true }).catch(() => {});
      await publishResponse(channel, requestId, {
        ok: true,
        status: 'ok',
        version: '0.18.1',
        figmaConnected: Boolean(activePairingId),
        miroConnected: true,
        sessions: 1,
        transport: 'ably-bridge',
      });
      logCloud(`Miro linked via Ably control channel (${pairingId})`);
      return;
    }

    if (type === 'select') {
      try {
        const localRes = await invoke<LocalExportResponse>('bridge_request_local', {
          pairingId,
          payload: {
            id: requestId,
            action: 'select',
            client: 'miro',
          },
          timeoutMs: 10_000,
        });
        if (localRes.error) {
          await publishResponse(channel, requestId, { ok: false, error: localRes.error });
        } else {
          await publishResponse(channel, requestId, { ok: true, data: localRes.data ?? localRes });
        }
      } catch (err: unknown) {
        await publishResponse(channel, requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (type === 'sync-image') {
      if (!cmd.boardId || !cmd.itemId || !cmd.nodeId || !cmd.miroToken) {
        await publishResponse(channel, requestId, {
          ok: false,
          error: 'Missing required sync-image parameters',
        });
        return;
      }

      try {
        // Step 1: Export frame locally from Figma Desktop via ws://localhost:4401 (0 Figma REST calls)
        const exportRes = await invoke<LocalExportResponse>('bridge_request_local', {
          pairingId,
          payload: {
            id: requestId,
            action: 'export',
            fileKey: cmd.fileKey,
            shapeId: cmd.nodeId,
            format: cmd.format === 'svg' ? 'svg' : 'png',
            scale: typeof cmd.scale === 'number' ? cmd.scale : 2,
            client: 'miro',
          },
          timeoutMs: 25_000,
        });

        const dataUrl = exportRes.data?.dataUrl || exportRes.dataUrl;
        const resolvedName = exportRes.data?.name || exportRes.name || cmd.nodeName || '';
        if (exportRes.error || !dataUrl) {
          await publishResponse(channel, requestId, {
            ok: false,
            fallbackToCloud: true,
            error: exportRes.error || 'Frame not found in open Figma file',
          });
          return;
        }

        // Step 2: Upload binary directly from Rust to Miro REST API v2 (50 MB limit, 0 Vercel, 0 Ably image bytes)
        await invoke('bridge_patch_miro_image', {
          miroToken: cmd.miroToken,
          request: {
            boardId: cmd.boardId,
            itemId: cmd.itemId,
            nodeName: resolvedName,
            width: cmd.width,
            dataUrl,
            format: cmd.format === 'svg' ? 'svg' : 'png',
            preserveSize: Boolean(cmd.preserveSize),
          },
        });

        await publishResponse(channel, requestId, {
          ok: true,
          data: {
            itemId: cmd.itemId,
            name: resolvedName,
            local: true,
          },
        });
      } catch (err: unknown) {
        await publishResponse(channel, requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const connectAbly = async (pairingId: string): Promise<void> => {
    if (connectedPairingId === pairingId && ablyClient) return;
    disconnectAbly();

    const apiBase = getApiBase();
    const tokenUrl = `${apiBase}/api/ably/token?pairingId=${encodeURIComponent(pairingId)}&platform=figma&tabId=syncingbridge`;

    try {
      const res = await fetch(tokenUrl, { cache: 'no-store' });
      if (!res.ok) {
        logCloud(`Ably token request failed (HTTP ${res.status}) — local-only mode remains active.`);
        return;
      }
      const tokenDetails = (await res.json()) as Ably.TokenDetails;
      // Guard against disconnect while token was in flight
      if (!cloudEnabled || hasLocalTarget || activePairingId !== pairingId) {
        return;
      }

      const client = new Ably.Realtime({
        authCallback: async (_params, callback) => {
          try {
            const refreshRes = await fetch(tokenUrl, { cache: 'no-store' });
            if (!refreshRes.ok) {
              callback(`HTTP ${refreshRes.status}`, null);
              return;
            }
            const refreshed = (await refreshRes.json()) as Ably.TokenDetails;
            callback(null, refreshed);
          } catch (err: unknown) {
            callback(err instanceof Error ? err.message : String(err), null);
          }
        },
        tokenDetails,
      });

      const channel = client.channels.get(`figma:${pairingId}`);
      ablyClient = client;
      ablyChannel = channel;
      connectedPairingId = pairingId;

      client.connection.on('connected', () => {
        void channel.presence
          .enter({ ready: true, bridge: true, version: '0.18.0' })
          .catch(() => {});
        logCloud(`Connected to Ably control channel (figma:${pairingId}) — ready for hosted Miro.`);
      });

      await channel.subscribe('bridge-cmd', (msg) => {
        if (!msg.data || typeof msg.data !== 'object') return;
        const cmd = msg.data as BridgeCommandPayload;
        void handleBridgeCommand(channel, pairingId, cmd);
      });
    } catch (err: unknown) {
      logCloud(`Ably control channel error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const reconcileConnection = async (): Promise<void> => {
    if (!cloudEnabled) {
      disconnectAbly('disabled in Settings');
      return;
    }
    if (hasLocalTarget) {
      disconnectAbly('local Miro target active (0 Ably mode)');
      return;
    }
    if (!activePairingId) {
      disconnectAbly('Figma companion disconnected');
      return;
    }
    await connectAbly(activePairingId);
  };

  void listen<BridgePairingEvent>('bridge_pairing_active', (ev) => {
    const { pairingId, active } = ev.payload;
    if (active && pairingId) {
      activePairingId = pairingId;
    } else if (!active) {
      activePairingId = null;
    }
    void reconcileConnection();
  });

  void listen<BridgeLocalTargetEvent>('bridge_local_target', (ev) => {
    hasLocalTarget = Boolean(ev.payload.active);
    void reconcileConnection();
  });

  void listen<BridgeSourceEvent>('bridge_source_event', (ev) => {
    if (!ablyChannel || !connectedPairingId) return;
    const { event, payload } = ev.payload;
    if (event === 'hotkey') {
      void ablyChannel.publish('hotkey', payload).catch(() => {});
      return;
    }
    if (event === 'selection') {
      pendingSelectionPayload = payload;
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        selectionTimer = null;
        if (ablyChannel && pendingSelectionPayload !== null) {
          void ablyChannel.publish('selection', pendingSelectionPayload).catch(() => {});
          pendingSelectionPayload = null;
        }
      }, SELECTION_DEBOUNCE_MS);
    }
  });
}
