/**
 * Companion Core - Token & Auth Lifecycle Utilities
 */

import { CompanionPlatform, AblyTokenResponse } from './types';

export class CompanionConflictError extends Error {
  constructor(message: string = 'companion_conflict') {
    super(message);
    this.name = 'CompanionConflictError';
  }
}

export class CompanionRateLimitError extends Error {
  public retryAfter?: number;
  constructor(message: string = 'Rate limit exceeded', retryAfter?: number) {
    super(message);
    this.name = 'CompanionRateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class CompanionTokenError extends Error {
  public status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'CompanionTokenError';
    this.status = status;
  }
}

/**
 * Builds the URL to request an ephemeral Ably token from the SyncingBoard server.
 */
export function buildAblyTokenUrl(
  relayUrl: string,
  pairingId: string,
  platform: CompanionPlatform,
  tabId: string
): string {
  const base = (relayUrl || '').replace(/\/+$/, '');
  return `${base}/api/ably/token?pairingId=${encodeURIComponent(
    pairingId
  )}&platform=${encodeURIComponent(platform)}&tabId=${encodeURIComponent(tabId)}`;
}

/**
 * Fetches an Ably token with deterministic conflict (409) and rate-limit (429) error detection.
 */
export async function fetchAblyToken(
  relayUrl: string,
  pairingId: string,
  platform: CompanionPlatform,
  tabId: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<AblyTokenResponse> {
  const tokenUrl = buildAblyTokenUrl(relayUrl, pairingId, platform, tabId);
  const response = await fetchFn(tokenUrl, { cache: 'no-store' });

  if (response.status === 409) {
    throw new CompanionConflictError();
  }

  if (response.status === 429) {
    const retryAfterHeader = response.headers?.get('Retry-After');
    const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;
    throw new CompanionRateLimitError('Rate limit exceeded', retryAfter);
  }

  if (!response.ok) {
    throw new CompanionTokenError(
      response.status,
      `Ably token request failed: HTTP ${response.status}`
    );
  }

  return (await response.json()) as AblyTokenResponse;
}
