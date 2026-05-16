// Drizzle schema for the panel's auth tables.
//
// Better-auth's `drizzleAdapter` requires Drizzle table definitions; these
// match the shape better-auth expects for its core (user/session/account) plus
// the SSO plugin (sso_provider). The panel-specific `approvals` table lives
// alongside.
//
// All tables live in the same `polaris-email` D1 as services/api. Better-auth
// owns the user/session/account/verification/sso_provider tables; the panel
// owns the `approvals` table for the two-person sensitive-action flow.
//
// The `step_ups` table that previously backed a self-elevation flow has been
// dropped — destructive actions are now exclusively gated on two-person
// approvals. See `migrations/0001_drop_step_ups.sql` for the D1 drop.
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  name: text('name'),
  image: text('image'),
  // Panel-specific: cached admin flag set by the OIDC role-sync hook.
  admin: integer('admin', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  scope: text('scope'),
  idToken: text('id_token'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

// SSO plugin (OIDC providers).
export const ssoProvider = sqliteTable('sso_provider', {
  id: text('id').primaryKey(),
  providerId: text('provider_id').notNull().unique(),
  issuer: text('issuer').notNull(),
  domain: text('domain'),
  oidcConfig: text('oidc_config'),
  samlConfig: text('saml_config'),
  userId: text('user_id'),
  organizationId: text('organization_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

// Panel-specific: two-person approvals.
export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  requesterUserId: text('requester_user_id').notNull(),
  approverUserId: text('approver_user_id'),
  action: text('action').notNull(), // e.g. "api_key.revoke", "tenant.quarantine"
  resourceId: text('resource_id').notNull(),
  payload: text('payload').notNull(), // JSON
  status: text('status').notNull().default('pending'), // pending | approved | rejected | expired
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});
