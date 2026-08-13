/**
 * Companion Core - Validation and Extraction Utilities
 */

import { CompanionPlatform } from './types';

export const PAIRING_ID_REGEX = /^sb_[a-z0-9]{4,16}$/i;
export const FIGMA_URL_REGEX = /(?:file|design)\/([a-zA-Z0-9_-]+)/;

/**
 * Validates whether a given string is a valid SyncingBoard pairing identifier (sb_...).
 */
export function isValidPairingId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  return PAIRING_ID_REGEX.test(id.trim());
}

/**
 * Sanitizes and trims a pairing identifier.
 */
export function sanitizePairingId(id: unknown): string {
  if (typeof id !== 'string') return '';
  return id.trim();
}

/**
 * Extracts a Figma fileKey from a full Figma URL (supporting both /file/KEY and /design/KEY paths).
 */
export function extractFigmaFileKey(url: string): string | null {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(FIGMA_URL_REGEX);
  return match && match[1] ? match[1] : null;
}

/**
 * Generates a stable tab ID using crypto.randomUUID when available, or a random fallback.
 */
export function generateTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      // Fallback below
    }
  }
  return 'tab_' + Math.random().toString(36).substring(2, 10);
}

/**
 * Validates whether a given string is a valid tab identifier.
 */
export function isValidTabId(id: unknown): id is string {
  return typeof id === 'string' && id.trim().length > 0;
}

/**
 * Validates companion platform name.
 */
export function isValidPlatform(platform: unknown): platform is CompanionPlatform {
  return platform === 'figma' || platform === 'penpot';
}
