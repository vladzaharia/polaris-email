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
    return body !== null && body !== undefined;
  } catch {
    return true;
  }
}

const rootRoute = createRootRoute({
  beforeLoad: async ({ location }) => {
    if (location.pathname === '/login') return;
    if (!(await hasSession())) {
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
const credentialsList = createRoute({
  getParentRoute: () => rootRoute,
  path: '/credentials',
  component: lazyRouteComponent(() => import('./pages/credentials/List.js'), 'CredentialsList'),
  errorComponent: RouteError,
});
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
const webhookSubsList = createRoute({
  getParentRoute: () => rootRoute,
  path: '/webhook-subs',
  component: lazyRouteComponent(() => import('./pages/webhook-subs/List.js'), 'WebhookSubsList'),
  errorComponent: RouteError,
});
const webhookSubDetail = createRoute({
  getParentRoute: () => rootRoute,
  path: '/webhook-subs/$id',
  component: lazyRouteComponent(() => import('./pages/webhook-subs/Detail.js'), 'WebhookSubDetail'),
  errorComponent: RouteError,
});
const routingList = createRoute({
  getParentRoute: () => rootRoute,
  path: '/routing',
  component: lazyRouteComponent(() => import('./pages/routing/List.js'), 'RoutingList'),
  errorComponent: RouteError,
});
// /routing/$id was removed — receiver detail pages are nested under
// MailboxDetail's Receivers section, so the standalone route was a redundant
// stub. Routing list rows now link to the parent mailbox.
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
const testSend = createRoute({
  getParentRoute: () => rootRoute,
  path: '/test-send',
  component: lazyRouteComponent(() => import('./pages/test-send/Form.js'), 'TestSendForm'),
  errorComponent: RouteError,
});
const account = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/account',
  component: lazyRouteComponent(() => import('./pages/settings/Account.js'), 'Account'),
  errorComponent: RouteError,
});
const diagnostics = createRoute({
  getParentRoute: () => rootRoute,
  path: '/diagnostics',
  component: lazyRouteComponent(() => import('./pages/diagnostics/Diagnostics.js'), 'Diagnostics'),
  errorComponent: RouteError,
});
const cfZonesList = createRoute({
  getParentRoute: () => rootRoute,
  path: '/cf-zones',
  component: lazyRouteComponent(() => import('./pages/cf-zones/List.js'), 'CfZonesList'),
  errorComponent: RouteError,
});
const cfZoneDetail = createRoute({
  getParentRoute: () => rootRoute,
  path: '/cf-zones/$name',
  component: lazyRouteComponent(() => import('./pages/cf-zones/Detail.js'), 'CfZoneDetail'),
  errorComponent: RouteError,
});
const suppressionsList = createRoute({
  getParentRoute: () => rootRoute,
  path: '/suppressions',
  component: lazyRouteComponent(() => import('./pages/suppressions/List.js'), 'SuppressionsList'),
  errorComponent: RouteError,
});
const abuseReportsList = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reports/abuse',
  component: lazyRouteComponent(() => import('./pages/reports/Abuse.js'), 'AbuseReportsList'),
  errorComponent: RouteError,
});
const triageReportsList = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reports/triage',
  component: lazyRouteComponent(() => import('./pages/reports/Triage.js'), 'TriageReportsList'),
  errorComponent: RouteError,
});
const adminAlertsList = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin-alerts',
  component: lazyRouteComponent(() => import('./pages/admin-alerts/List.js'), 'AdminAlertsList'),
  errorComponent: RouteError,
});
const senderAbuseList = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sender-abuse',
  component: lazyRouteComponent(() => import('./pages/sender-abuse/List.js'), 'SenderAbuseList'),
  errorComponent: RouteError,
});
const dmarcPromotionList = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dmarc-promotion',
  component: lazyRouteComponent(
    () => import('./pages/dmarc-promotion/List.js'),
    'DmarcPromotionList',
  ),
  errorComponent: RouteError,
});
const suppressionDetail = createRoute({
  getParentRoute: () => rootRoute,
  path: '/suppressions/$id',
  component: lazyRouteComponent(
    () => import('./pages/suppressions/Detail.js'),
    'SuppressionDetail',
  ),
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
  credentialsList,
  credentialDetail,
  messagesList,
  messageDetail,
  webhookSubsList,
  webhookSubDetail,
  routingList,
  dlqBrowser,
  bridgesList,
  bridgeDetail,
  testSend,
  account,
  diagnostics,
  cfZonesList,
  cfZoneDetail,
  suppressionsList,
  suppressionDetail,
  abuseReportsList,
  triageReportsList,
  adminAlertsList,
  senderAbuseList,
  dmarcPromotionList,
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
