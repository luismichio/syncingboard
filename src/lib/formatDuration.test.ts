import { describe, it, expect } from 'vitest';
import { formatDuration, formatCooldownTime } from './formatDuration';

describe('formatDuration', () => {
  it('handles zero and negative durations', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-10)).toBe('0s');
    expect(formatDuration(NaN)).toBe('0s');
  });

  it('formats seconds under one minute', () => {
    expect(formatDuration(1)).toBe('1s');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(59)).toBe('59s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(750)).toBe('12m 30s');
    expect(formatDuration(3540)).toBe('59m');
    expect(formatDuration(3599)).toBe('59m 59s');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(3660)).toBe('1h 1m');
    expect(formatDuration(43200)).toBe('12h');
    expect(formatDuration(45120)).toBe('12h 32m');
    expect(formatDuration(86340)).toBe('23h 59m');
  });

  it('formats days and hours', () => {
    expect(formatDuration(86400)).toBe('1d');
    expect(formatDuration(90000)).toBe('1d 1h');
    expect(formatDuration(172800)).toBe('2d');
  });
});

describe('formatCooldownTime', () => {
  it('returns plain duration for short times under 15 minutes', () => {
    expect(formatCooldownTime(45)).toBe('45s');
    expect(formatCooldownTime(600, Date.now() + 600000)).toBe('10m');
  });

  it('appends clock time for durations 15 minutes or longer when reset timestamp is provided', () => {
    const future = new Date('2026-08-15T14:30:00Z').getTime();
    const result = formatCooldownTime(43200, future);
    expect(result).toMatch(/^12h \(at .+\)$/);
  });
});
