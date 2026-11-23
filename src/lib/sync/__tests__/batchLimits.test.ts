import { describe, it, expect } from 'vitest';
import {
  CLOUD_BATCH_LIMIT,
  LOCAL_FIGMA_BATCH_LIMIT,
  PENPOT_BATCH_LIMIT,
  evaluateBatchLimits,
} from '../batchLimits';

const makeGroups = (figma: number, penpot: number) => [
  ...Array.from({ length: figma }, () => ({ platform: 'figma' as const })),
  ...Array.from({ length: penpot }, () => ({ platform: 'penpot' as const })),
];

describe('evaluateBatchLimits', () => {
  it('enforces the 3-item cloud cap when useTauri is false', () => {
    expect(evaluateBatchLimits(makeGroups(3, 0), false).blocked).toBe(false);
    expect(evaluateBatchLimits(makeGroups(2, 1), false).blocked).toBe(false);

    const over = evaluateBatchLimits(makeGroups(4, 0), false);
    expect(over.blocked).toBe(true);
    expect(over.reason).toContain(String(CLOUD_BATCH_LIMIT));
  });

  it('allows up to 50 local Figma items when useTauri is true', () => {
    expect(evaluateBatchLimits(makeGroups(10, 0), true).blocked).toBe(false);
    expect(evaluateBatchLimits(makeGroups(LOCAL_FIGMA_BATCH_LIMIT, 0), true).blocked).toBe(false);

    const over = evaluateBatchLimits(makeGroups(LOCAL_FIGMA_BATCH_LIMIT + 1, 0), true);
    expect(over.blocked).toBe(true);
    expect(over.reason).toContain('Figma');
  });

  it('keeps the 3-item cap for Penpot even when useTauri is true', () => {
    expect(evaluateBatchLimits(makeGroups(12, PENPOT_BATCH_LIMIT), true).blocked).toBe(false);

    const over = evaluateBatchLimits(makeGroups(5, PENPOT_BATCH_LIMIT + 1), true);
    expect(over.blocked).toBe(true);
    expect(over.reason).toContain('Penpot');
    expect(over.reason).toContain('dismiss 1 Penpot card');
  });
});
