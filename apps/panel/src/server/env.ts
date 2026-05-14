export interface PanelEnv {
  POLARIS_EMAIL_URL: string;
  PANEL_ADMIN_KEY_ID: string;
  PANEL_ADMIN_KEY_SECRET: string;
  PANEL_PORT: string;
  SQLITE_PATH: string;
  ADMIN_GROUP: string;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_REDIRECT_URL?: string;
  DEV_MODE?: string;
}

export function readEnv(): PanelEnv {
  const need = (k: keyof PanelEnv) => {
    const v = process.env[k];
    if (!v) throw new Error(`missing env ${k}`);
    return v;
  };
  return {
    POLARIS_EMAIL_URL: need('POLARIS_EMAIL_URL'),
    PANEL_ADMIN_KEY_ID: need('PANEL_ADMIN_KEY_ID'),
    PANEL_ADMIN_KEY_SECRET: need('PANEL_ADMIN_KEY_SECRET'),
    PANEL_PORT: process.env.PANEL_PORT ?? '3000',
    SQLITE_PATH: process.env.SQLITE_PATH ?? './panel.db',
    ADMIN_GROUP: process.env.ADMIN_GROUP ?? 'polaris-admins',
    ...(process.env.OIDC_ISSUER ? { OIDC_ISSUER: process.env.OIDC_ISSUER } : {}),
    ...(process.env.OIDC_CLIENT_ID ? { OIDC_CLIENT_ID: process.env.OIDC_CLIENT_ID } : {}),
    ...(process.env.OIDC_CLIENT_SECRET
      ? { OIDC_CLIENT_SECRET: process.env.OIDC_CLIENT_SECRET }
      : {}),
    ...(process.env.OIDC_REDIRECT_URL ? { OIDC_REDIRECT_URL: process.env.OIDC_REDIRECT_URL } : {}),
    ...(process.env.DEV_MODE ? { DEV_MODE: process.env.DEV_MODE } : {}),
  };
}
