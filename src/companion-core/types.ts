/**
 * Companion Core - Type Definitions
 * Strictly typed contracts for Figma and Penpot companion plugins.
 */

export type CompanionPlatform = 'figma' | 'penpot';

export type CompanionSessionAction = 'release' | 'transfer';

export interface CompanionSessionRequest {
  pairingId: string;
  tabId: string;
  action: CompanionSessionAction;
}

export interface AblyTokenResponse {
  token?: string;
  keyName?: string;
  issued?: number;
  expires?: number;
  capability?: string;
  clientId?: string;
  [key: string]: unknown;
}

export interface SelectionPayload {
  id: string;
  name?: string;
  fileKey?: string;
  format?: 'png' | 'svg' | string;
  scale?: number;
  width?: number;
  height?: number;
  base64?: string;
  svg?: string;
  bytes?: Uint8Array;
  [key: string]: unknown;
}

export interface RelayCommand {
  id: string;
  action: 'select' | 'export';
  [key: string]: unknown;
}

export interface RelayCompanionEvent {
  event: 'companion_transferred' | 'companion_evicted';
  tabId: string;
}

export interface RelayResultPayload {
  requestId: string;
  pairingId?: string;
  data?: SelectionPayload | null;
  error?: string | null;
}

export interface StreamSelectionEvent {
  name: string;
  id: string;
  fileKey: string;
  ts: number;
}

export type HostToCompanionMessage =
  | { action: 'ui-ready' }
  | { action: 'theme-change'; theme: 'light' | 'dark' | 'os' }
  | { action: 'selection-changed-locally'; data?: SelectionPayload | null }
  | { action: 'selection-result'; requestId: string; data?: SelectionPayload | null; selectionCount?: number }
  | { action: 'export-result'; requestId: string; data?: SelectionPayload | null; error?: string | null };

export type CompanionToHostMessage =
  | { action: 'ui-ready' }
  | { action: 'link-file'; fileKey: string }
  | { action: 'get-selection'; requestId: string }
  | { action: 'export-frame'; requestId: string; format?: string; scale?: number };

export type CompanionStatus = 'disconnected' | 'connecting' | 'connected';

export type SessionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'conflict'
  | 'standby'
  | 'transferred'
  | 'disconnected'
  | 'failed';

export interface CompanionLogger {
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}
