// Environment + bridge config types.
export interface SidecarEnv {
  POLARIS_EMAIL_URL: string;
  POLARIS_BRIDGE_KEY_ID: string;
  POLARIS_BRIDGE_KEY_SECRET: string;
  MOX_WEBAPI_SOCK?: string;
  MOX_WEBAPI_URL?: string;
  MOX_CONFIG_PATH?: string;
  LISTEN_PORT?: string;
  POLL_INTERVAL_MS?: string;
}

export function envOrThrow(): SidecarEnv {
  const need = (k: keyof SidecarEnv) => {
    const v = process.env[k];
    if (!v) throw new Error(`missing env ${k}`);
    return v;
  };
  const r: SidecarEnv = {
    POLARIS_EMAIL_URL: need('POLARIS_EMAIL_URL'),
    POLARIS_BRIDGE_KEY_ID: need('POLARIS_BRIDGE_KEY_ID'),
    POLARIS_BRIDGE_KEY_SECRET: need('POLARIS_BRIDGE_KEY_SECRET'),
  };
  for (const opt of [
    'MOX_WEBAPI_SOCK',
    'MOX_WEBAPI_URL',
    'MOX_CONFIG_PATH',
    'LISTEN_PORT',
    'POLL_INTERVAL_MS',
  ] as const) {
    const v = process.env[opt];
    if (v) r[opt] = v;
  }
  return r;
}

/** Map polaris-email error codes to SMTP reply codes for the submissions path. */
export const SMTP_ERROR_MAP: Record<string, string> = {
  scope_violation: '550 5.7.1 sender_scope_violation',
  rate_limited: '451 4.7.1 rate_limited',
  domain_not_verified: '550 5.7.10 domain_not_verified',
  key_revoked: '535 5.7.8 key_revoked',
  bad_signature: '535 5.7.8 bad_signature',
  cf_upstream: '421 4.3.0 cf_upstream',
  nonce_replay: '550 5.7.1 nonce_replay',
  recipient_rejected: '550 5.1.1 recipient_rejected',
  idempotency_conflict: '550 5.7.1 idempotency_conflict',
  degraded: '421 4.3.0 degraded',
  bad_request: '550 5.7.1 bad_request',
  not_found: '550 5.7.1 not_found',
  unauthorized: '535 5.7.8 unauthorized',
  forbidden: '550 5.7.1 forbidden',
  clock_skew: '451 4.7.1 clock_skew',
  conflict: '550 5.7.1 conflict',
};
