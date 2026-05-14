// `after:signIn` role-sync hook.
//
// Reads the OIDC `groups` claim from the IdP's userinfo response and sets the
// panel's cached `admin` flag if the user is in `env.ADMIN_GROUP`. The flag is
// then read by middleware on every request without a roundtrip to the IdP.
//
// If your IdP emits groups under a different claim name (e.g. `cf-access-groups`,
// `roles`), extend the candidate list below.
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import type { Env } from '../env.js';
import * as schema from './schema.js';

const GROUP_CLAIMS = ['groups', 'roles', 'cf-access-groups', 'cf_access_groups'] as const;

export async function afterSignInRoleSync(
  env: Env,
  userId: string,
  userInfo: Record<string, unknown> | undefined,
): Promise<void> {
  if (!userInfo) return;
  const groups = extractGroups(userInfo);
  const isAdmin = groups.includes(env.ADMIN_GROUP);
  const db = drizzle(env.DB, { schema });
  await db
    .update(schema.user)
    .set({ admin: isAdmin, updatedAt: new Date() })
    .where(eq(schema.user.id, userId));
}

function extractGroups(userInfo: Record<string, unknown>): string[] {
  for (const claim of GROUP_CLAIMS) {
    const v = userInfo[claim];
    if (Array.isArray(v)) return v.map((x) => String(x));
    if (typeof v === 'string') {
      // Space- or comma-separated.
      return v.split(/[\s,]+/).filter(Boolean);
    }
  }
  return [];
}
