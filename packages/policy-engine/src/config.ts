// policy_config resolver.
//
// Merge order (later wins): global → domain → mailbox. Each scope's row
// stores a partial JSON {bands?, weights?} that overlays onto the previous.

import {
  DEFAULT_BANDS,
  type D1,
  type PolicyBands,
  type PolicyConfig,
  type ReasonCode,
} from './types.js';

interface ConfigRow {
  config_json: string;
}

interface PartialConfig {
  bands?: Partial<PolicyBands>;
  weights?: Record<ReasonCode, number>;
}

function mergeConfig(into: PolicyConfig, layer: PartialConfig): PolicyConfig {
  return {
    bands: { ...into.bands, ...(layer.bands ?? {}) },
    weights: { ...into.weights, ...(layer.weights ?? {}) },
  };
}

function parsePartial(raw: string): PartialConfig {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object') return {};
  const obj = parsed as Record<string, unknown>;
  const out: PartialConfig = {};
  if (obj.bands && typeof obj.bands === 'object') out.bands = obj.bands as Partial<PolicyBands>;
  if (obj.weights && typeof obj.weights === 'object') {
    out.weights = obj.weights as Record<ReasonCode, number>;
  }
  return out;
}

/**
 * Load and merge policy_config rows for the given scope chain.
 *
 * Looks up rows in this order: ('global', NULL), ('domain', domain_id),
 * ('mailbox', mailbox_id). Later rows override earlier ones.
 */
export async function loadPolicyConfig(
  db: D1,
  scopes: { domain_id?: string; mailbox_id?: string },
): Promise<PolicyConfig> {
  let config: PolicyConfig = { bands: DEFAULT_BANDS, weights: {} };

  const global = await db
    .prepare(`SELECT config_json FROM policy_config WHERE scope_type='global' LIMIT 1`)
    .first<ConfigRow>();
  if (global) config = mergeConfig(config, parsePartial(global.config_json));

  if (scopes.domain_id) {
    const domain = await db
      .prepare(
        `SELECT config_json FROM policy_config WHERE scope_type='domain' AND scope_target=? LIMIT 1`,
      )
      .bind(scopes.domain_id)
      .first<ConfigRow>();
    if (domain) config = mergeConfig(config, parsePartial(domain.config_json));
  }

  if (scopes.mailbox_id) {
    const mailbox = await db
      .prepare(
        `SELECT config_json FROM policy_config WHERE scope_type='mailbox' AND scope_target=? LIMIT 1`,
      )
      .bind(scopes.mailbox_id)
      .first<ConfigRow>();
    if (mailbox) config = mergeConfig(config, parsePartial(mailbox.config_json));
  }

  return config;
}
