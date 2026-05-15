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
} from '@tanstack/react-router';
import { RootLayout } from './layouts/RootLayout.js';
import { SidebarLayout } from './layouts/SidebarLayout.js';
import { RouteError } from './components/RouteError.js';

const rootRoute = createRootRoute({
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
const routingDetail = createRoute({
  getParentRoute: () => rootRoute,
  path: '/routing/$id',
  component: lazyRouteComponent(() => import('./pages/routing/Detail.js'), 'RoutingDetail'),
  errorComponent: RouteError,
});
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
  routingDetail,
  dlqBrowser,
  bridgesList,
  bridgeDetail,
  testSend,
  account,
  diagnostics,
]);

const router = new Router({
  routeTree,
  defaultErrorComponent: RouteError,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function AppRouter() {
  return <RouterProvider router={router} />;
}
