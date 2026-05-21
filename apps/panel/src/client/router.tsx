// TanStack Router setup — code-based routing.
//
// All page modules are wrapped in `lazyRouteComponent` so the initial
// JS bundle ships just the shell + login; everything else loads on
// navigation. `errorComponent: RouteError` gives each route its own
// in-page error fallback (the outer `ErrorBoundary` in `RootLayout` is
// still the last-resort safety net).
import {
  Outlet,
  Router,
  RouterProvider,
  createRootRoute,
  createRoute,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import { RootLayout } from './layouts/RootLayout.js';
import { SidebarLayout } from './layouts/SidebarLayout.js';
import { RouteError } from './components/RouteError.js';
import { PageSkeleton } from './components/PageSkeleton.js';

// Probe better-auth for the current session. Returns true if signed in,
// false if anonymous, true (fail-open) on network/server hiccups so a
// transient panel hiccup doesn't lock the operator out — the protected
// admin API calls themselves still 401 in that case, surfacing the auth
// failure in-page rather than via a redirect loop.
async function hasSession(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/get-session', { credentials: 'include' });
    if (!res.ok) return true;
    const body = (await res.json()) as unknown;
    const ok = body !== null && body !== undefined;
    // eslint-disable-next-line no-console
    console.log('[panel/auth] get-session ->', { status: res.status, body, ok });
    return ok;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[panel/auth] get-session threw, failing open:', e);
    return true;
  }
}

const rootRoute = createRootRoute({
  beforeLoad: async ({ location }) => {
    // eslint-disable-next-line no-console
    console.log('[panel/router] beforeLoad', {
      pathname: location.pathname,
      search: location.search,
      cookie: document.cookie,
    });
    if (location.pathname === '/login') return;
    if (!(await hasSession())) {
      // eslint-disable-next-line no-console
      console.log('[panel/router] no session, redirecting to /login');
      throw redirect({ to: '/login' });
    }
  },
  component: () => (
    <RootLayout>
      <SidebarLayout>
        <Outlet />
      </SidebarLayout>
    </RootLayout>
  ),
  errorComponent: RouteError,
});

// Login lives outside the sidebar layout, so it has its own thin root.
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: lazyRouteComponent(() => import('./pages/Login.js'), 'Login'),
  errorComponent: RouteError,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: lazyRouteComponent(() => import('./pages/Dashboard.js'), 'Dashboard'),
  errorComponent: RouteError,
});

const mailboxesList = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mailboxes',
  component: lazyRouteComponent(() => import('./pages/mailboxes/List.js'), 'MailboxesList'),
  errorComponent: RouteError,
});
const mailboxDetail = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mailboxes/$id',
  component: lazyRouteComponent(() => import('./pages/mailboxes/Detail.js'), 'MailboxDetail'),
  errorComponent: RouteError,
});
const domainsList = createRoute({
  getParentRoute: () => rootRoute,
  path: '/domains',
  component: lazyRouteComponent(() => import('./pages/domains/List.js'), 'DomainsList'),
  errorComponent: RouteError,
});
const domainDetail = createRoute({
  getParentRoute: () => rootRoute,
  path: '/domains/$id',
  component: lazyRouteComponent(() => import('./pages/domains/Detail.js'), 'DomainDetail'),
  errorComponent: RouteError,
});
// /credentials standalone list removed (Stage 4 consolidation); the page was
// a mailbox picker funnel whose data now lives inline on /mailboxes/$id.
// /credentials/$id stays — it's the rotate/revoke + stats surface, reached
// from the inline table.
const credentialDetail = createRoute({
  getParentRoute: () => rootRoute,
  path: '/credentials/$id',
  component: lazyRouteComponent(() => import('./pages/credentials/Detail.js'), 'CredentialDetail'),
  errorComponent: RouteError,
});
const messagesList = createRoute({
  getParentRoute: () => rootRoute,
  path: '/messages',
  component: lazyRouteComponent(() => import('./pages/messages/List.js'), 'MessagesList'),
  errorComponent: RouteError,
});
const messageDetail = createRoute({
  getParentRoute: () => rootRoute,
  path: '/messages/$id',
  component: lazyRouteComponent(() => import('./pages/messages/Detail.js'), 'MessageDetail'),
  errorComponent: RouteError,
});
// /webhook-subs standalone list removed (same rationale as /credentials).
// The per-mailbox table now lives on the mailbox detail page. Detail stays
// for edit / test / pause / delete.
const webhookSubDetail = createRoute({
  getParentRoute: () => rootRoute,
  path: '/webhook-subs/$id',
  component: lazyRouteComponent(() => import('./pages/webhook-subs/Detail.js'), 'WebhookSubDetail'),
  errorComponent: RouteError,
});
// /routing removed — the per-mailbox receiver table on MailboxDetail is the
// single source of truth. /routing/$id was already gone.
const dlqBrowser = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dlq',
  component: lazyRouteComponent(() => import('./pages/dlq/Browser.js'), 'DlqBrowser'),
  errorComponent: RouteError,
});
const bridgesList = createRoute({
  getParentRoute: () => rootRoute,
  path: '/bridges',
  component: lazyRouteComponent(() => import('./pages/bridges/List.js'), 'BridgesList'),
  errorComponent: RouteError,
});
const bridgeDetail = createRoute({
  getParentRoute: () => rootRoute,
  path: '/bridges/$id',
  component: lazyRouteComponent(() => import('./pages/bridges/Detail.js'), 'BridgeDetail'),
  errorComponent: RouteError,
});
// /test-send removed — folded into MailboxDetail as an inline SendTestDialog
// action so operators don't have to leave the mailbox to fire a smoke send.
// /settings/account collapsed into /me (Stage-4 follow-up). The /me hub
// combines OIDC identity, the matched operators-row, and recent audit
// activity for the current user.
const me = createRoute({
  getParentRoute: () => rootRoute,
  path: '/me',
  component: lazyRouteComponent(() => import('./pages/me/Me.js'), 'Me'),
  errorComponent: RouteError,
});
const diagnostics = createRoute({
  getParentRoute: () => rootRoute,
  path: '/diagnostics',
  component: lazyRouteComponent(() => import('./pages/diagnostics/Diagnostics.js'), 'Diagnostics'),
  errorComponent: RouteError,
});
// /cf-zones and /cf-zones/$name removed — CF zone status now renders as a
// section on /domains/$id with the same checks engine.
// /dmarc-promotion removed — fold-in tab/section on /domains/$id.
// /suppressions standalone list removed (Stage 4-followup): folded into
// /abuse as the fifth tab. /suppressions/$id detail still resolves; rows on
// the new tab link to it.
const suppressionDetail = createRoute({
  getParentRoute: () => rootRoute,
  path: '/suppressions/$id',
  component: lazyRouteComponent(
    () => import('./pages/suppressions/Detail.js'),
    'SuppressionDetail',
  ),
  errorComponent: RouteError,
});
// Consolidated abuse hub — collapses /reports/abuse + /reports/triage +
// /admin-alerts + /sender-abuse into one tabbed page. `?tab=...` preserves
// deep links.
const abuseHub = createRoute({
  getParentRoute: () => rootRoute,
  path: '/abuse',
  validateSearch: (
    search: Record<string, unknown>,
  ): { tab?: 'complaints' | 'triage' | 'alerts' | 'senders' | 'suppressions' } => {
    const t = search.tab;
    if (
      t === 'complaints' ||
      t === 'triage' ||
      t === 'alerts' ||
      t === 'senders' ||
      t === 'suppressions'
    ) {
      return { tab: t };
    }
    return {};
  },
  component: lazyRouteComponent(() => import('./pages/abuse/AbuseHub.js'), 'AbuseHub'),
  errorComponent: RouteError,
});
const policyModeration = createRoute({
  getParentRoute: () => rootRoute,
  path: '/policy/moderation',
  component: lazyRouteComponent(() => import('./pages/policy/Moderation.js'), 'PolicyModeration'),
  errorComponent: RouteError,
});
const policyDecisions = createRoute({
  getParentRoute: () => rootRoute,
  path: '/policy/decisions',
  component: lazyRouteComponent(() => import('./pages/policy/Decisions.js'), 'PolicyDecisions'),
  errorComponent: RouteError,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  dashboardRoute,
  mailboxesList,
  mailboxDetail,
  domainsList,
  domainDetail,
  credentialDetail,
  messagesList,
  messageDetail,
  webhookSubDetail,
  dlqBrowser,
  bridgesList,
  bridgeDetail,
  me,
  diagnostics,
  suppressionDetail,
  abuseHub,
  policyModeration,
  policyDecisions,
]);

// Phase 6d.8 — `defaultPendingComponent` swaps in PageSkeleton on every
// lazy route load, so navigation to a not-yet-fetched chunk shows a
// stable skeleton instead of a blank panel. `defaultPendingMs` keeps the
// skeleton from flashing for fast transitions.
const router = new Router({
  routeTree,
  defaultErrorComponent: RouteError,
  defaultPendingComponent: PageSkeleton,
  defaultPendingMs: 200,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function AppRouter() {
  return <RouterProvider router={router} />;
}
