// Relative time with an absolute tooltip. The tooltip carries the
// localized date+time including the user's timezone, so a "2 hours ago"
// label can still be cross-checked against the raw timestamp at a hover.
import { formatDate, formatRelative } from '../lib/format.js';

export interface LocalDateTimeProps {
  ts: number | string | Date | null | undefined;
  /** Optional className applied to the wrapping span. */
  className?: string;
}

function tzAbbrev(d: Date): string {
  try {
    return (
      Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
        .formatToParts(d)
        .find((p) => p.type === 'timeZoneName')?.value ?? ''
    );
  } catch {
    return '';
  }
}

export function LocalDateTime({ ts, className }: LocalDateTimeProps) {
  if (ts == null) return <span className={className}>—</span>;
  const d = new Date(ts as number | string | Date);
  if (Number.isNaN(d.getTime())) return <span className={className}>—</span>;
  const tz = tzAbbrev(d);
  const tooltip = tz ? `${formatDate(d)} (${tz})` : formatDate(d);
  return (
    <time className={className} dateTime={d.toISOString()} title={tooltip}>
      {formatRelative(d)}
    </time>
  );
}
