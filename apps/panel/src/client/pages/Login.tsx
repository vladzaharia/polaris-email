import { PageCard } from '../layouts/PageCard.js';
import { Button } from '../components/ui/button.js';

export function Login() {
  return (
    <PageCard title="Sign in" description="OIDC via Cloudflare Access (or another configured IdP).">
      <Button asChild>
        <a href="/api/auth/sign-in/sso?provider=default">Continue with SSO</a>
      </Button>
    </PageCard>
  );
}
