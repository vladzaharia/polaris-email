// Hierarchical TanStack Query key factories.
//
// One factory per entity. Keys nest under `.all` so mutations can invalidate
// either the whole entity (`mailboxKeys.all`) or just one detail (
// `mailboxKeys.detail(id)`) without stringly-typed key arrays scattered across
// pages.
//
// Naming: list/detail/stats/etc. Add more leaves as pages need them.

export const mailboxKeys = {
  all: ['mailboxes'] as const,
  list: () => [...mailboxKeys.all, 'list'] as const,
  detail: (id: string) => [...mailboxKeys.all, 'detail', id] as const,
  recentMessages: (id: string) => [...mailboxKeys.all, 'recent-messages', id] as const,
};

export const domainKeys = {
  all: ['domains'] as const,
  list: () => [...domainKeys.all, 'list'] as const,
  detail: (id: string) => [...domainKeys.all, 'detail', id] as const,
};

export const credentialKeys = {
  all: ['credentials'] as const,
  list: (mailboxId?: string) =>
    mailboxId
      ? ([...credentialKeys.all, 'list', mailboxId] as const)
      : ([...credentialKeys.all, 'list'] as const),
  detail: (id: string) => [...credentialKeys.all, 'detail', id] as const,
  stats: (id: string) => [...credentialKeys.all, 'stats', id] as const,
};

export const webhookKeys = {
  all: ['webhook-subs'] as const,
  list: (mailboxId?: string) =>
    mailboxId
      ? ([...webhookKeys.all, 'list', mailboxId] as const)
      : ([...webhookKeys.all, 'list'] as const),
  detail: (id: string) => [...webhookKeys.all, 'detail', id] as const,
};

// Bridges.
export const bridgeKeys = {
  all: ['bridges'] as const,
  list: () => [...bridgeKeys.all, 'list'] as const,
  detail: (id: string) => [...bridgeKeys.all, 'detail', id] as const,
};

export const dlqKeys = {
  all: ['webhook-dlq'] as const,
  list: () => [...dlqKeys.all, 'list'] as const,
};

export const auditKeys = {
  all: ['audit'] as const,
  chain: () => [...auditKeys.all, 'chain'] as const,
  chainStatus: () => [...auditKeys.all, 'chain-status'] as const,
};

export const messageKeys = {
  all: ['messages'] as const,
  list: () => [...messageKeys.all, 'list'] as const,
  detail: (id: string) => [...messageKeys.all, 'detail', id] as const,
};

export const statsKeys = {
  all: ['stats'] as const,
  overview: (window: string) => [...statsKeys.all, 'overview', window] as const,
};

export const diagnosticsKeys = {
  all: ['diagnostics'] as const,
  panel: () => [...diagnosticsKeys.all, 'panel'] as const,
  health: () => [...diagnosticsKeys.all, 'health'] as const,
  queues: () => [...diagnosticsKeys.all, 'queues'] as const,
  recentFailures: () => [...diagnosticsKeys.all, 'recent-failures'] as const,
  auditAnchor: () => [...diagnosticsKeys.all, 'audit-anchor'] as const,
};

// Cloudflare-zone discover-and-configure (Phase 2 of CF zone feature).
// Backed by `/api/admin/cf-zones` proxy → `/v1/admin/cf-zones`.
export const cfZoneKeys = {
  all: ['cf-zones'] as const,
  list: () => [...cfZoneKeys.all, 'list'] as const,
  detail: (name: string) => [...cfZoneKeys.all, 'detail', name] as const,
};

// Sender abuse profiles (W2c) — per-principal tier + lifetime counters.
export const senderAbuseKeys = {
  all: ['sender-abuse'] as const,
  list: (filters?: Record<string, string | undefined>) =>
    [...senderAbuseKeys.all, 'list', filters ?? {}] as const,
  detail: (type: string, id: string) => [...senderAbuseKeys.all, 'detail', type, id] as const,
};

// Admin alerts (W2d) — operator-facing alert history.
export const adminAlertKeys = {
  all: ['admin-alerts'] as const,
  list: (filters?: Record<string, string | undefined>) =>
    [...adminAlertKeys.all, 'list', filters ?? {}] as const,
  detail: (id: string) => [...adminAlertKeys.all, 'detail', id] as const,
};

// Abuse events (W2) — append-only ledger of complaint events.
export const abuseEventKeys = {
  all: ['abuse-events'] as const,
  list: (filters?: Record<string, string | undefined>) =>
    [...abuseEventKeys.all, 'list', filters ?? {}] as const,
  detail: (id: string) => [...abuseEventKeys.all, 'detail', id] as const,
  summary: (sender: string) => [...abuseEventKeys.all, 'summary', sender] as const,
};

// Suppressions (W1) — bi-directional do-not-send list. Two tabs in the panel
// (Recipients / Senders), each filterable; detail page shows the source
// evidence + lifetime stats.
export const suppressionKeys = {
  all: ['suppressions'] as const,
  list: (filters?: Record<string, string | undefined>) =>
    [...suppressionKeys.all, 'list', filters ?? {}] as const,
  detail: (id: string) => [...suppressionKeys.all, 'detail', id] as const,
  check: (address: string) => [...suppressionKeys.all, 'check', address] as const,
};
