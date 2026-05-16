// Score → verdict band classifier.
//
// Inbound and outbound share the same band thresholds but differ on whether
// the uncertain band invokes the LLM tier. Outbound never invokes the LLM
// (cost-saving decision) and routes uncertain straight to 'hold'.

import type { Direction, PolicyBands, Verdict } from './types.js';

export type Band = 'pass' | 'pass_warn' | 'uncertain' | 'hold' | 'block_decisive';

const BLOCK_DECISIVE_THRESHOLD = -25;

export function classifyBand(score: number, bands: PolicyBands): Band {
  if (score <= BLOCK_DECISIVE_THRESHOLD) return 'block_decisive';
  if (score <= bands.hold_max) return 'hold';
  if (score <= bands.uncertain_max) return 'uncertain';
  if (score <= bands.pass_warn_max) return 'pass_warn';
  return 'pass';
}

/**
 * Translate a band → verdict given the direction.
 *
 * The only direction-sensitive cell is `uncertain`:
 *   - inbound  → caller will invoke the LLM tiebreaker; this function returns
 *               'hold' as the heuristic-only default. Caller may override after
 *               the LLM responds (re-call this fn with the LLM-adjusted score).
 *   - outbound → 'hold' (no LLM cost spent — admin moderates instead).
 */
export function bandToVerdict(band: Band, _direction: Direction): Verdict {
  switch (band) {
    case 'pass':
      return 'pass';
    case 'pass_warn':
      return 'pass_warn';
    case 'uncertain':
      return 'hold';
    case 'hold':
      return 'hold';
    case 'block_decisive':
      return 'block';
  }
}
