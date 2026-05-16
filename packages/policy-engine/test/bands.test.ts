import { describe, expect, it } from 'vitest';
import { classifyBand, bandToVerdict } from '../src/bands.js';
import { DEFAULT_BANDS } from '../src/types.js';

describe('classifyBand with default bands', () => {
  it('pass for score >= 0', () => {
    expect(classifyBand(0, DEFAULT_BANDS)).toBe('pass');
    expect(classifyBand(5, DEFAULT_BANDS)).toBe('pass');
    expect(classifyBand(100, DEFAULT_BANDS)).toBe('pass');
  });

  it('pass_warn for -4..-1', () => {
    expect(classifyBand(-1, DEFAULT_BANDS)).toBe('pass_warn');
    expect(classifyBand(-4, DEFAULT_BANDS)).toBe('pass_warn');
  });

  it('uncertain for -14..-5', () => {
    expect(classifyBand(-5, DEFAULT_BANDS)).toBe('uncertain');
    expect(classifyBand(-10, DEFAULT_BANDS)).toBe('uncertain');
    expect(classifyBand(-14, DEFAULT_BANDS)).toBe('uncertain');
  });

  it('hold for -24..-15', () => {
    expect(classifyBand(-15, DEFAULT_BANDS)).toBe('hold');
    expect(classifyBand(-20, DEFAULT_BANDS)).toBe('hold');
    expect(classifyBand(-24, DEFAULT_BANDS)).toBe('hold');
  });

  it('block_decisive for <= -25', () => {
    expect(classifyBand(-25, DEFAULT_BANDS)).toBe('block_decisive');
    expect(classifyBand(-100, DEFAULT_BANDS)).toBe('block_decisive');
  });
});

describe('bandToVerdict', () => {
  it('uncertain band defaults to hold on both directions', () => {
    // For inbound the engine *may* override after LLM tiebreaker —
    // bandToVerdict itself returns the heuristic-only default.
    expect(bandToVerdict('uncertain', 'inbound')).toBe('hold');
    expect(bandToVerdict('uncertain', 'outbound')).toBe('hold');
  });

  it('block_decisive → block', () => {
    expect(bandToVerdict('block_decisive', 'inbound')).toBe('block');
    expect(bandToVerdict('block_decisive', 'outbound')).toBe('block');
  });

  it('pass / pass_warn / hold map straight through', () => {
    expect(bandToVerdict('pass', 'inbound')).toBe('pass');
    expect(bandToVerdict('pass_warn', 'outbound')).toBe('pass_warn');
    expect(bandToVerdict('hold', 'inbound')).toBe('hold');
  });
});
