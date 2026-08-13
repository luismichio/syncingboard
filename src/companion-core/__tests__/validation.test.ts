import { describe, it, expect } from 'vitest';
import {
  isValidPairingId,
  sanitizePairingId,
  extractFigmaFileKey,
  generateTabId,
  isValidTabId,
  isValidPlatform,
} from '../validation';

describe('Companion Validation Utilities', () => {
  describe('isValidPairingId', () => {
    it('validates standard pairing IDs (sb_xxxx)', () => {
      expect(isValidPairingId('sb_abc123')).toBe(true);
      expect(isValidPairingId('sb_test')).toBe(true);
      expect(isValidPairingId('sb_1234567890ab')).toBe(true);
      expect(isValidPairingId('  sb_trimmed  ')).toBe(true);
    });

    it('rejects invalid pairing IDs', () => {
      expect(isValidPairingId('')).toBe(false);
      expect(isValidPairingId('abc123')).toBe(false);
      expect(isValidPairingId('sb_')).toBe(false);
      expect(isValidPairingId('sb_ab')).toBe(false); // too short
      expect(isValidPairingId('sb_very_long_pairing_id_exceeding_max')).toBe(false);
      expect(isValidPairingId(null)).toBe(false);
      expect(isValidPairingId(undefined)).toBe(false);
      expect(isValidPairingId(12345)).toBe(false);
    });
  });

  describe('sanitizePairingId', () => {
    it('trims whitespace and handles edge cases', () => {
      expect(sanitizePairingId('  sb_abc  ')).toBe('sb_abc');
      expect(sanitizePairingId(null)).toBe('');
      expect(sanitizePairingId(undefined)).toBe('');
    });
  });

  describe('extractFigmaFileKey', () => {
    it('extracts fileKey from various Figma URL formats', () => {
      expect(
        extractFigmaFileKey('https://www.figma.com/design/aB3k9X123/My-Design-System?node-id=1:2')
      ).toBe('aB3k9X123');
      expect(
        extractFigmaFileKey('https://www.figma.com/file/xYz98765/Legacy-File-Path')
      ).toBe('xYz98765');
      expect(
        extractFigmaFileKey('https://figma.com/design/simpleKey')
      ).toBe('simpleKey');
    });

    it('returns null for invalid URLs', () => {
      expect(extractFigmaFileKey('')).toBeNull();
      expect(extractFigmaFileKey('https://miro.com/app/board/uXjVO123=/')).toBeNull();
      expect(extractFigmaFileKey('not-a-url')).toBeNull();
    });
  });

  describe('generateTabId & isValidTabId', () => {
    it('generates non-empty string tab IDs', () => {
      const tabId = generateTabId();
      expect(typeof tabId).toBe('string');
      expect(tabId.length).toBeGreaterThan(5);
      expect(isValidTabId(tabId)).toBe(true);
    });

    it('validates tab IDs properly', () => {
      expect(isValidTabId('tab_12345')).toBe(true);
      expect(isValidTabId('')).toBe(false);
      expect(isValidTabId('   ')).toBe(false);
      expect(isValidTabId(null)).toBe(false);
    });
  });

  describe('isValidPlatform', () => {
    it('validates supported platforms', () => {
      expect(isValidPlatform('figma')).toBe(true);
      expect(isValidPlatform('penpot')).toBe(true);
      expect(isValidPlatform('miro')).toBe(false);
      expect(isValidPlatform('sketch')).toBe(false);
    });
  });
});
