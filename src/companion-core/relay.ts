/**
 * Companion Core - Relay Channel & Result Publishing Utilities
 */

import { CompanionPlatform, SelectionPayload } from './types';

/**
 * Builds the canonical Ably channel name for a companion session.
 */
export function getRelayChannelName(platform: CompanionPlatform, pairingId: string): string {
  const safeId = (pairingId || '').trim();
  return `${platform}:${safeId}`;
}

/**
 * Determines whether a payload can be transmitted directly inline over Ably WebSocket (<12KB)
 * instead of round-tripping through Upstash Redis.
 */
export function canInlinePayload(
  data: SelectionPayload | null | undefined,
  maxInlineBytes: number = 12_000
): boolean {
  if (!data) return true;
  if (data.base64) return false;
  if (data.svg) {
    const payloadSize = JSON.stringify(data).length;
    return payloadSize < maxInlineBytes;
  }
  return true;
}

/**
 * Submits a result either directly via Ably (inline) or via the Upstash Redis fallback route.
 */
export async function submitRelayResult(options: {
  relayUrl: string;
  pairingId: string;
  requestId: string;
  data?: SelectionPayload | null;
  error?: string | null;
  platform: CompanionPlatform;
  ablyChannel?: { publish: (event: string, msg: unknown) => Promise<unknown> } | null;
  fetchFn?: typeof fetch;
}): Promise<{ inlined: boolean; success: boolean; error?: string }> {
  const { relayUrl, pairingId, requestId, data, error, platform, ablyChannel, fetchFn = globalThis.fetch } =
    options;

  const canInline = canInlinePayload(data);

  if (canInline && ablyChannel) {
    try {
      await ablyChannel.publish('result', { requestId, data: data || null, error: error || null });
      return { inlined: true, success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (platform !== 'penpot') {
        return { inlined: true, success: false, error: errMsg };
      }
      // Penpot falls through to HTTP fallback
    }
  }

  if (platform === 'penpot') {
    try {
      const base = (relayUrl || '').replace(/\/+$/, '');
      const res = await fetchFn(`${base}/api/relay/penpot/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, pairingId, data: data || null, error: error || null }),
      });

      if (!res.ok) {
        throw new Error(`HTTP status ${res.status}`);
      }

      if (ablyChannel) {
        await ablyChannel.publish('result-ready', { requestId });
      }

      return { inlined: false, success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { inlined: false, success: false, error: errMsg };
    }
  }

  return { inlined: true, success: false, error: 'Ably channel disconnected' };
}
