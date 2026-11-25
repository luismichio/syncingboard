import { NextResponse } from 'next/server';
import { parseBridgePort } from '@/lib/sync/bridgeValidation';

export const dynamic = 'force-dynamic';

export async function GET(request?: Request) {
  let rawPort: string | null = null;
  if (request?.url) {
    const url = new URL(request.url);
    rawPort = url.searchParams.get('port') ?? request.headers.get('x-bridge-port');
  }

  const port = parseBridgePort(rawPort);
  if (port === null) {
    return NextResponse.json(
      { error: 'Invalid bridge port. Expected integer between 1024 and 65535.' },
      { status: 400 }
    );
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
    });
    if (res.ok) {
      const data = await res.json();
      return NextResponse.json(data);
    }
    return NextResponse.json(
      { error: 'Bridge returned non-200 status' },
      { status: res.status }
    );
  } catch {
    return NextResponse.json(
      { error: `SyncingBridge is unreachable on 127.0.0.1:${port}` },
      { status: 503 }
    );
  }
}
