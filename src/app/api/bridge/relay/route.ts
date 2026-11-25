import { NextRequest, NextResponse } from 'next/server';
import {
  clampBridgeTimeout,
  parseBridgePort,
  resolveAllowedBridgeWsOrigin,
} from '@/lib/sync/bridgeValidation';

export const dynamic = 'force-dynamic';

interface RelayRequestBody {
  pairingId: string;
  port?: number | string;
  platform?: 'figma' | 'penpot';
  action: 'select' | 'export';
  fileKey?: string;
  shapeId?: string;
  format?: 'svg' | 'png';
  scale?: number;
  timeoutMs?: number;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as RelayRequestBody;
    if (!body || !body.pairingId) {
      return NextResponse.json({ error: 'Missing pairingId' }, { status: 400 });
    }

    const bridgePort = parseBridgePort(body.port ?? request.headers.get('x-bridge-port'));
    const wsOrigin = bridgePort !== null ? resolveAllowedBridgeWsOrigin(bridgePort) : null;
    if (!wsOrigin) {
      return NextResponse.json(
        { error: 'Invalid bridge port. Expected integer between 4401 and 4410.' },
        { status: 400 }
      );
    }

    const clampedTimeout = clampBridgeTimeout(body.timeoutMs, 8000);
    const safeTimeoutMs = Math.min(Math.max(Number(clampedTimeout) || 8000, 1000), 30000);
    const reqId = 'req_' + Math.random().toString(36).slice(2, 9);

    if (typeof WebSocket === 'undefined') {
      return NextResponse.json({ error: 'WebSocket not supported in runtime' }, { status: 500 });
    }

    const ws = new WebSocket(`${wsOrigin}/ws`);

    const result = await new Promise<{ ok: boolean; data?: unknown; error?: string }>((resolve) => {
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
          resolve({ ok: false, error: 'Local Bridge request timed out. Make sure the Companion plugin is open in Figma/Penpot.' });
        }
      }, safeTimeoutMs);

      ws.onopen = () => {
        // Register channel
        ws.send(JSON.stringify({
          action: 'register',
          pairing_id: body.pairingId,
          role: 'target',
        }));

        if ((body.action as string) === 'sync-event') {
          ws.send(JSON.stringify({
            action: 'broadcast',
            pairing_id: body.pairingId,
            event: 'sync-event',
            payload: { message: (body as unknown as Record<string, unknown>).message || 'Syncing...' },
          }));
          cleanup();
          resolve({ ok: true, data: { status: 'broadcasted' } });
          return;
        }

        // Broadcast command to companion
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

          if ((raw.event === 'result' || raw.action === 'result') && raw.payload) {
            const payload = raw.payload as { id?: string; requestId?: string; data?: unknown; error?: string };
            const responseId = payload.id || payload.requestId;
            if (!responseId || responseId === reqId) {
              cleanup();
              if (payload.error) {
                resolve({ ok: false, error: payload.error });
              } else {
                resolve({ ok: true, data: payload.data ?? payload });
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
          resolve({ ok: false, error: `Failed to connect to local SyncingBridge on 127.0.0.1:${bridgePort}` });
        }
      };
    });

    if (result.ok) {
      return NextResponse.json({ ok: true, data: result.data });
    }
    return NextResponse.json({ error: result.error }, { status: 404 });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}
