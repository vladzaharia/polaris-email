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

export const routingKeys = {
  all: ['routing'] as const,
  list: () => [...routingKeys.all, 'list'] as const,
  detail: (id: string) => [...routingKeys.all, 'detail', id] as const,
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
