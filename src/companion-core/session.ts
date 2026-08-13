/**
 * Companion Core - Session State Management & Lifecycle Actions
 */

import { CompanionSessionAction, SessionState, CompanionStatus } from './types';

/**
 * Exponential backoff for normal connection drop recovery (2s, 4s, 8s, 16s max).
 */
export function calculateReconnectBackoff(attempt: number, maxDelayMs: number = 16_000): number {
  const safeAttempt = Math.max(1, attempt);
  return Math.min(2000 * Math.pow(2, safeAttempt), maxDelayMs);
}

/**
 * Stepped linear backoff for evicted Standby re-admission (5s, 10s... up to 60s max).
 */
export function calculateStandbyBackoff(attempt: number, maxDelayMs: number = 60_000): number {
  const safeAttempt = Math.max(1, attempt);
  return Math.min(5000 * Math.ceil(safeAttempt / 3), maxDelayMs);
}

/**
 * Dispatches a session action (transfer or release) to the serverless relay API.
 */
export async function sendSessionAction(
  relayUrl: string,
  pairingId: string,
  tabId: string,
  action: CompanionSessionAction,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<boolean> {
  const base = (relayUrl || '').replace(/\/+$/, '');
  const url = `${base}/api/relay/companion/session`;

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingId, tabId, action }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Sends a non-blocking release beacon via navigator.sendBeacon during pagehide/unload.
 */
export function sendReleaseBeacon(
  relayUrl: string,
  pairingId: string,
  tabId: string
): boolean {
  if (!pairingId || !tabId) return false;
  const base = (relayUrl || '').replace(/\/+$/, '');
  const url = `${base}/api/relay/companion/session`;

  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      const payload = JSON.stringify({ pairingId, tabId, action: 'release' });
      const blob = new Blob([payload], { type: 'application/json' });
      return navigator.sendBeacon(url, blob);
    } catch {
      // Fallback
    }
  }

  // Fallback to async fetch (ignore response)
  void sendSessionAction(relayUrl, pairingId, tabId, 'release');
  return true;
}

/**
 * Companion Session State Machine
 */
export class CompanionStateMachine {
  private state: SessionState = 'idle';
  private pairingId: string = '';
  private tabId: string;
  private reconnectAttempts: number = 0;
  private standbyAttempts: number = 0;
  private isConflict: boolean = false;
  private onStateChange?: (state: SessionState, status: CompanionStatus, text?: string) => void;

  constructor(
    tabId: string,
    onStateChange?: (state: SessionState, status: CompanionStatus, text?: string) => void
  ) {
    this.tabId = tabId;
    this.onStateChange = onStateChange;
  }

  getState(): SessionState {
    return this.state;
  }

  getPairingId(): string {
    return this.pairingId;
  }

  getTabId(): string {
    return this.tabId;
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  getStandbyAttempts(): number {
    return this.standbyAttempts;
  }

  startConnecting(pairingId: string): void {
    this.pairingId = pairingId;
    this.isConflict = false;
    this.state = 'connecting';
    this.notify('connecting', 'Connecting WebSocket');
  }

  setConnected(): void {
    this.state = 'connected';
    this.reconnectAttempts = 0;
    this.standbyAttempts = 0;
    this.isConflict = false;
    this.notify('connected', 'Connected');
  }

  setConflict(): void {
    this.state = 'conflict';
    this.isConflict = true;
    this.notify('disconnected', 'Active elsewhere');
  }

  setStandby(): void {
    this.state = 'standby';
    this.standbyAttempts++;
    this.notify('disconnected', 'Standby (Slot granted to active sync)');
  }

  setTransferred(): void {
    this.state = 'transferred';
    this.pairingId = '';
    this.notify('disconnected', 'Moved to another tab');
  }

  setDisconnected(reason?: string): void {
    this.state = 'disconnected';
    this.notify('disconnected', reason || 'Disconnected');
  }

  setFailed(message?: string): void {
    this.state = 'failed';
    this.notify('disconnected', message || 'Failed');
  }

  incrementReconnect(): number {
    this.reconnectAttempts++;
    return this.reconnectAttempts;
  }

  resetReconnect(): void {
    this.reconnectAttempts = 0;
  }

  resetStandby(): void {
    this.standbyAttempts = 0;
  }

  private notify(status: CompanionStatus, text?: string): void {
    if (this.onStateChange) {
      this.onStateChange(this.state, status, text);
    }
  }
}
