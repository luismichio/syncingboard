/**
 * Companion Core - Protocol Message Guards and Handlers
 */

import {
  HostToCompanionMessage,
  RelayCommand,
  RelayCompanionEvent,
  SelectionPayload,
  RelayResultPayload,
  StreamSelectionEvent,
} from './types';

/**
 * Type guard for messages received from the plugin wrapper host (Figma or Penpot).
 */
export function isHostMessage(data: unknown): data is HostToCompanionMessage {
  if (!data || typeof data !== 'object') return false;
  const action = (data as { action?: unknown }).action;
  return typeof action === 'string' && [
    'ui-ready',
    'theme-change',
    'selection-changed-locally',
    'selection-result',
    'export-result',
  ].includes(action);
}

/**
 * Type guard for RelayCommand payloads arriving from Miro over Ably.
 */
export function isRelayCommand(data: unknown): data is RelayCommand {
  if (!data || typeof data !== 'object') return false;
  const obj = data as { id?: unknown; action?: unknown };
  return typeof obj.id === 'string' && (obj.action === 'select' || obj.action === 'export');
}

/**
 * Type guard for companion event notifications (eviction or transfer).
 */
export function isRelayCompanionEvent(data: unknown): data is RelayCompanionEvent {
  if (!data || typeof data !== 'object') return false;
  const obj = data as { event?: unknown; tabId?: unknown };
  return (
    typeof obj.tabId === 'string' &&
    (obj.event === 'companion_transferred' || obj.event === 'companion_evicted')
  );
}

/**
 * Encodes a SelectionStream event for live relay-pull in FigJam/Miro.
 */
export function encodeSelectionStream(
  name: string,
  id: string,
  fileKey: string
): StreamSelectionEvent {
  return {
    name: name || '',
    id,
    fileKey: fileKey || '',
    ts: Date.now(),
  };
}

/**
 * Encodes a Result payload to publish back to Miro.
 */
export function encodeRelayResult(
  requestId: string,
  data?: SelectionPayload | null,
  error?: string | null,
  pairingId?: string
): RelayResultPayload {
  return {
    requestId,
    data: data || null,
    error: error || null,
    ...(pairingId ? { pairingId } : {}),
  };
}

/**
 * Pending Request Tracker with bounded TTL to prevent ghost requests and memory leaks.
 */
export class PendingRequestManager {
  private pending = new Map<string, { id: string; timestamp: number }>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly timeoutMs: number;
  private readonly onExpire?: (reqId: string) => void;

  constructor(timeoutMs: number = 15_000, onExpire?: (reqId: string) => void) {
    this.timeoutMs = timeoutMs;
    this.onExpire = onExpire;
  }

  track(reqId: string): void {
    if (this.timers.has(reqId)) {
      const existingTimer = this.timers.get(reqId);
      if (existingTimer) clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.pending.delete(reqId);
      this.timers.delete(reqId);
      if (this.onExpire) {
        this.onExpire(reqId);
      }
    }, this.timeoutMs);

    this.pending.set(reqId, { id: reqId, timestamp: Date.now() });
    this.timers.set(reqId, timer);
  }

  take(reqId: string): { id: string; timestamp: number } | undefined {
    const item = this.pending.get(reqId);
    const timer = this.timers.get(reqId);
    if (timer) clearTimeout(timer);
    this.pending.delete(reqId);
    this.timers.delete(reqId);
    return item;
  }

  has(reqId: string): boolean {
    return this.pending.has(reqId);
  }

  size(): number {
    return this.pending.size;
  }

  clear(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
    this.timers.clear();
  }
}
