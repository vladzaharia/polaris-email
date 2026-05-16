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

// Compact relative formatter — "just now", "5m ago", "2h ago", "yesterday",
// "3d ago", or the absolute date for older entries. Callers display this in
// table cells where a full ISO timestamp would dominate the row; pair it with
// a tooltip showing the absolute value if precision matters.
export function formatRelative(ms: number | string | Date | null | undefined): string {
  if (ms == null) return '—';
  const d = typeof ms === 'string' || typeof ms === 'number' ? new Date(ms) : ms;
  if (Number.isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  if (diff < 0) return formatDate(d);
  const s = Math.floor(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const dys = Math.floor(h / 24);
  if (dys === 1) return 'yesterday';
  if (dys < 30) return `${dys}d ago`;
  // Fall through to absolute for anything older — a relative figure stops
  // being useful past a month.
  return formatDate(d);
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
