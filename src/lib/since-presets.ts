/**
 * since-presets.ts
 *
 * Relative lookback window presets for email sync.
 * Simplified from the Anthropic ingestor — same preset values.
 */

export const SINCE_PRESETS = [
  '1h', '2h', '4h', '6h', '12h',
  '1d', '3d',
  '1w', '2w',
  '1mo', '2mo', '3mo', '6mo',
  '1y',
  'all',
] as const;

export type SincePreset = typeof SINCE_PRESETS[number];

export const CADENCE_PRESETS = [
  '1h', '2h', '4h', '6h', '12h',
  '1d', '3d',
  '1w', '2w',
  '1mo',
] as const;

export type CadencePreset = typeof CADENCE_PRESETS[number];

export const CADENCE_PRESET_MINUTES: Record<CadencePreset, number> = {
  '1h': 60,
  '2h': 120,
  '4h': 240,
  '6h': 360,
  '12h': 720,
  '1d': 1440,
  '3d': 4320,
  '1w': 10080,
  '2w': 20160,
  '1mo': 43200,
};

export function isSincePreset(value: unknown): value is SincePreset {
  return typeof value === 'string' && (SINCE_PRESETS as readonly string[]).includes(value);
}

export function isCadencePreset(value: unknown): value is CadencePreset {
  return typeof value === 'string' && (CADENCE_PRESETS as readonly string[]).includes(value);
}

export function sincePresetToMs(preset: SincePreset): number {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  switch (preset) {
    case '1h':   return HOUR;
    case '2h':   return 2 * HOUR;
    case '4h':   return 4 * HOUR;
    case '6h':   return 6 * HOUR;
    case '12h':  return 12 * HOUR;
    case '1d':   return DAY;
    case '3d':   return 3 * DAY;
    case '1w':   return 7 * DAY;
    case '2w':   return 14 * DAY;
    case '1mo':  return 30 * DAY;
    case '2mo':  return 60 * DAY;
    case '3mo':  return 90 * DAY;
    case '6mo':  return 180 * DAY;
    case '1y':   return 365 * DAY;
    case 'all':  return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Resolve a SincePreset to a cutoff timestamp in milliseconds.
 * Returns 0 for 'all' (sync from beginning).
 */
export function resolveSincePresetToMs(preset: SincePreset, now: Date = new Date()): number {
  if (preset === 'all') return 0;
  return now.getTime() - sincePresetToMs(preset);
}

/**
 * Compute the next UTC-boundary-aligned timestamp for the given cadence.
 */
export function computeNextBoundary(cadence: CadencePreset, now: Date = new Date()): Date {
  const ms = now.getTime();
  const msP = ms + 1;
  const REF_MONDAY_MS = 4 * 24 * 60 * 60_000;

  switch (cadence) {
    case '1h': { const p = 60 * 60_000; return new Date(Math.ceil(msP / p) * p); }
    case '2h': { const p = 2 * 60 * 60_000; return new Date(Math.ceil(msP / p) * p); }
    case '4h': { const p = 4 * 60 * 60_000; return new Date(Math.ceil(msP / p) * p); }
    case '6h': { const p = 6 * 60 * 60_000; return new Date(Math.ceil(msP / p) * p); }
    case '12h': { const p = 12 * 60 * 60_000; return new Date(Math.ceil(msP / p) * p); }
    case '1d': { const p = 24 * 60 * 60_000; return new Date(Math.ceil(msP / p) * p); }
    case '3d': { const p = 3 * 24 * 60 * 60_000; return new Date(Math.ceil(msP / p) * p); }
    case '1w': {
      const weekMs = 7 * 24 * 60 * 60_000;
      const periods = Math.ceil((msP - REF_MONDAY_MS) / weekMs);
      return new Date(REF_MONDAY_MS + periods * weekMs);
    }
    case '2w': {
      const twoWeekMs = 14 * 24 * 60 * 60_000;
      const periods = Math.ceil((msP - REF_MONDAY_MS) / twoWeekMs);
      return new Date(REF_MONDAY_MS + periods * twoWeekMs);
    }
    case '1mo': return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    default: { const p = 60 * 60_000; return new Date(Math.ceil(msP / p) * p); }
  }
}
