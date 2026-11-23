import { NextRequest, NextResponse } from 'next/server';
import { parseBridgePort } from '@/lib/sync/bridgeValidation';

export const dynamic = 'force-dynamic';

const PAIRING_ID_RE = /^sb_[A-Za-z0-9_-]{3,64}$/;

/**
 * Same-origin Server-Sent Events (SSE) bridge stream for live selection updates.
 * Connects server-side to ws://127.0.0.1:<port>/ws so Miro iframes blocked by
 * Chromium LNA still receive instant live Figma selections (0 Ably, 0 Upstash).
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const pairingId = url.searchParams.get('pairingId')?.trim() || '';
  const eventName = url.searchParams.get('event')?.trim() || 'selection';
  const rawPort = url.searchParams.get('port') ?? request.headers.get('x-bridge-port');

  if (!PAIRING_ID_RE.test(pairingId)) {
    return NextResponse.json({ error: 'Invalid or missing pairingId' }, { status: 400 });
  }

  const port = parseBridgePort(rawPort);
  if (port === null) {
    return NextResponse.json(
      { error: 'Invalid bridge port. Expected integer between 1024 and 65535.' },
      { status: 400 }
    );
  }

  if (typeof WebSocket === 'undefined') {
    return NextResponse.json({ error: 'WebSocket not supported in runtime' }, { status: 500 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let ws: WebSocket | null = null;
      let pingTimer: ReturnType<typeof setInterval> | null = null;

      const closeAll = () => {
        if (closed) return;
        closed = true;
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        if (ws) {
          ws.onopen = null;
          ws.onmessage = null;
          ws.onerror = null;
          ws.onclose = null;
          try {
            ws.close();
          } catch {
            // ignore
          }
          ws = null;
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const sendChunk = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closeAll();
        }
      };

      request.signal.addEventListener('abort', closeAll);

      try {
        ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      } catch {
        closeAll();
        return;
      }

      ws.onopen = () => {
        if (closed || !ws) return;
        ws.send(
          JSON.stringify({
            action: 'register',
            pairing_id: pairingId,
            role: 'target',
          })
        );
        sendChunk(': connected\n\n');
        pingTimer = setInterval(() => {
          sendChunk(': ping\n\n');
        }, 20_000);
      };

      ws.onmessage = (ev) => {
        if (closed) return;
        try {
          const raw = typeof ev.data === 'string' ? JSON.parse(ev.data) : null;
          if (raw && (raw.event === eventName || raw.action === eventName) && raw.payload) {
            sendChunk(`data: ${JSON.stringify(raw.payload)}\n\n`);
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onerror = () => {
        closeAll();
      };

      ws.onclose = () => {
        closeAll();
      };
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
