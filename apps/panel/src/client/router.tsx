// TanStack Router setup — code-based routing (file-based generation is a
// build-time step that conflicts with the panel's TSC-only client build). We
// build the route tree explicitly so types stay clean and the tree is the
// single source of navigation truth.
import {
  Outlet,
  Router,
  RouterProvider,
  createRootRoute,
  createRoute,
} from '@tanstack/react-router';
import { RootLayout } from './layouts/RootLayout.js';
import { SidebarLayout } from './layouts/SidebarLayout.js';
import { Dashboard } from './pages/Dashboard.js';
import { Login } from './pages/Login.js';
import { MailboxesList } from './pages/mailboxes/List.js';
import { MailboxDetail } from './pages/mailboxes/Detail.js';
import { DomainsList } from './pages/domains/List.js';
import { DomainDetail } from './pages/domains/Detail.js';
import { CredentialsList } from './pages/credentials/List.js';
import { CredentialDetail } from './pages/credentials/Detail.js';
import { MessagesList } from './pages/messages/List.js';
import { MessageDetail } from './pages/messages/Detail.js';
import { WebhookSubsList } from './pages/webhook-subs/List.js';
import { WebhookSubDetail } from './pages/webhook-subs/Detail.js';
import { RoutingList } from './pages/routing/List.js';
import { RoutingDetail } from './pages/routing/Detail.js';
import { DlqBrowser } from './pages/dlq/Browser.js';
import { DaemonsList } from './pages/daemons/List.js';
import { DaemonDetail } from './pages/daemons/Detail.js';
import { TestSendForm } from './pages/test-send/Form.js';
import { Account } from './pages/settings/Account.js';
import { Diagnostics } from './pages/diagnostics/Diagnostics.js';

const rootRoute = createRootRoute({
  component: () => (
    <RootLayout>
      <SidebarLayout>
        <Outlet />
      </SidebarLayout>
    </RootLayout>
  ),
});

// Login lives outside the sidebar layout, so it has its own thin root.
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: Login,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Dashboard,
});

const mailboxesList = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mailboxes',
  component: MailboxesList,
});
const mailboxDetail = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mailboxes/$id',
  component: MailboxDetail,
});
const domainsList = createRoute({
  getParentRoute: () => rootRoute,
  path: '/domains',
  component: DomainsList,
});
const domainDetail = createRoute({
  getParentRoute: () => rootRoute,
  path: '/domains/$id',
  component: DomainDetail,
});
const credentialsList = createRoute({
  getParentRoute: () => rootRoute,
  path: '/credentials',
  component: CredentialsList,
});
const credentialDetail = createRoute({
  getParentRoute: () => rootRoute,
  path: '/credentials/$id',
  component: CredentialDetail,
});
const messagesList = createRoute({
  getParentRoute: () => rootRoute,
  path: '/messages',
  component: MessagesList,
});
const messageDetail = createRoute({
  getParentRoute: () => rootRoute,
  path: '/messages/$id',
  component: MessageDetail,
});
const webhookSubsList = createRoute({
  getParentRoute: () => rootRoute,
  path: '/webhook-subs',
  component: WebhookSubsList,
});
const webhookSubDetail = createRoute({
  getParentRoute: () => rootRoute,
  path: '/webhook-subs/$id',
  component: WebhookSubDetail,
});
const routingList = createRoute({
  getParentRoute: () => rootRoute,
  path: '/routing',
  component: RoutingList,
});
const routingDetail = createRoute({
  getParentRoute: () => rootRoute,
  path: '/routing/$id',
  component: RoutingDetail,
});
const dlqBrowser = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dlq',
  component: DlqBrowser,
});
const daemonsList = createRoute({
  getParentRoute: () => rootRoute,
  path: '/daemons',
  component: DaemonsList,
});
const daemonDetail = createRoute({
  getParentRoute: () => rootRoute,
  path: '/daemons/$id',
  component: DaemonDetail,
});
const testSend = createRoute({
  getParentRoute: () => rootRoute,
  path: '/test-send',
  component: TestSendForm,
});
const account = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/account',
  component: Account,
});
const diagnostics = createRoute({
  getParentRoute: () => rootRoute,
  path: '/diagnostics',
  component: Diagnostics,
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
  daemonsList,
  daemonDetail,
  testSend,
  account,
  diagnostics,
]);

const router = new Router({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function AppRouter() {
  return <RouterProvider router={router} />;
}
