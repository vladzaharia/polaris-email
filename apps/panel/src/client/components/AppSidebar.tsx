// AppSidebar — left-rail navigation, grouped into Operations / Configuration
// / Diagnostics. Used by SidebarLayout both as the desktop fixed rail and as
// the Sheet body on mobile.
import { Link, useRouterState } from '@tanstack/react-router';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  AtSign,
  BarChart3,
  Cloud,
  Globe2,
  Inbox,
  Key,
  LayoutDashboard,
  Mail,
  Moon,
  Route,
  ServerCog,
  Settings,
  ShieldOff,
  Stethoscope,
  Sun,
  Webhook,
} from 'lucide-react';
import { cn } from '../lib/cn.js';
import { useTheme } from '../layouts/RootLayout.js';
import { Button } from './ui/button.js';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

// Sidebar IA — three groups, ordered by triage cadence:
//   Operations: day-to-day verbs (Dashboard, Messages, DLQ)
//   Configuration: long-lived registry objects (Mailboxes, Domains,
//     Credentials, Webhook subs, Routing, Bridges)
//   Diagnostics: incident-triage surfaces + per-account settings
//     (Diagnostics overview ABOVE Account so the system-health page is
//     reached faster during an incident)
const OPERATIONS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/messages', label: 'Messages', icon: Mail },
  { to: '/dlq', label: 'DLQ browser', icon: BarChart3 },
  { to: '/reports/abuse', label: 'Abuse reports', icon: AlertTriangle },
  { to: '/admin-alerts', label: 'Admin alerts', icon: AlertOctagon },
];

const CONFIGURATION: NavItem[] = [
  { to: '/mailboxes', label: 'Mailboxes', icon: Inbox },
  { to: '/cf-zones', label: 'CF Zones', icon: Cloud },
  { to: '/domains', label: 'Domains', icon: Globe2 },
  { to: '/credentials', label: 'Credentials', icon: Key },
  { to: '/webhook-subs', label: 'Webhook subs', icon: Webhook },
  { to: '/routing', label: 'Routing', icon: Route },
  { to: '/bridges', label: 'Bridges', icon: ServerCog },
  { to: '/suppressions', label: 'Suppressions', icon: ShieldOff },
];

const DIAGNOSTICS: NavItem[] = [
  { to: '/diagnostics', label: 'Diagnostics', icon: Stethoscope },
  { to: '/test-send', label: 'Test send', icon: Activity },
  { to: '/settings/account', label: 'Account', icon: AtSign },
];

function Section({
  title,
  items,
  currentPath,
}: {
  title: string;
  items: NavItem[];
  currentPath: string;
}) {
  return (
    <div className="px-3 py-2">
      <div className="px-2 pb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-sidebar-foreground)]/60">
        {title}
      </div>
      <ul className="space-y-1">
        {items.map((item) => {
          // Match the route to set aria-current=page so screen readers
          // announce the active link. Treat exact match as the canonical
          // signal — sub-routes (e.g. /mailboxes/$id) keep the parent active
          // because the prefix matches.
          const isActive =
            item.to === '/'
              ? currentPath === '/'
              : currentPath === item.to || currentPath.startsWith(item.to + '/');
          return (
            <li key={item.to}>
              <Link
                to={item.to}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--color-sidebar-foreground)]',
                  'hover:bg-[var(--color-sidebar-accent)] hover:text-[var(--color-sidebar-accent-foreground)]',
                  '[&.active]:bg-[var(--color-sidebar-accent)] [&.active]:text-[var(--color-sidebar-accent-foreground)]',
                )}
                activeProps={{ className: 'active' }}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => setTheme(next)}
      className="h-8 w-8"
    >
      {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}

export function AppSidebar() {
  // Read the router's current location for active-link styling +
  // `aria-current="page"` (Phase 6c.2). Falls back to '/' on the server.
  const currentPath = useRouterState({
    select: (s) => s.location.pathname,
  });
  return (
    <nav className="flex h-full flex-col gap-1 bg-[var(--color-sidebar)] text-[var(--color-sidebar-foreground)]">
      <div className="flex items-center gap-2 px-5 py-4">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-[var(--color-primary)] text-[var(--color-primary-foreground)]">
          <Settings className="h-4 w-4" />
        </div>
        <div className="text-sm font-semibold">polaris-email</div>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>
      <Section title="Operations" items={OPERATIONS} currentPath={currentPath} />
      <Section title="Configuration" items={CONFIGURATION} currentPath={currentPath} />
      <Section title="Diagnostics" items={DIAGNOSTICS} currentPath={currentPath} />
    </nav>
  );
}
