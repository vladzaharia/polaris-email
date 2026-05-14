// Format helpers used across pages.

export function formatDate(ms: number | string | Date | null | undefined): string {
  if (ms == null) return '—';
  const d = typeof ms === 'string' || typeof ms === 'number' ? new Date(ms) : ms;
  if (Number.isNaN(d.getTime())) return '—';
  return d
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z');
}

export function formatEmail(addr: string | null | undefined): string {
  if (!addr) return '—';
  // Strip display-name prefix if present: `Foo <a@b.c>` → `a@b.c`.
  const m = addr.match(/<([^>]+)>/);
  return m ? (m[1] as string) : addr;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
