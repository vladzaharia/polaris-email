// AppSidebar — left-rail navigation, grouped into Operations / Configuration
// / Tools. Used by SidebarLayout both as the desktop fixed rail and as the
// Sheet body on mobile.
import { Link, useRouterState } from '@tanstack/react-router';
import {
  ArchiveX,
  Cable,
  Flag,
  Gavel,
  Globe2,
  Inbox,
  LayoutDashboard,
  Mail,
  Moon,
  Scale,
  Send,
  Stethoscope,
  Sun,
  UserCog,
} from 'lucide-react';
import { cn } from '../lib/cn.js';
import { useTheme } from '../layouts/RootLayout.js';
import { Button } from './ui/button.js';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

// Post-IA-consolidation sidebar — 12 items in 3 groups.
//   Operations: day-to-day operator triage surfaces.
//   Configuration: long-lived registry objects. Credentials, webhook subs,
//     routing, CF zones, and DMARC promotion all fold into mailbox/domain
//     detail pages now.
//   Tools: incident-triage diagnostics + per-account settings. Test-send
//     folded into MailboxDetail as an inline action.
const OPERATIONS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/messages', label: 'Messages', icon: Send },
  { to: '/policy/moderation', label: 'Moderation', icon: Gavel },
  { to: '/policy/decisions', label: 'Policy decisions', icon: Scale },
  { to: '/dlq', label: 'DLQ', icon: ArchiveX },
  { to: '/abuse', label: 'Abuse & alerts', icon: Flag },
];

const CONFIGURATION: NavItem[] = [
  { to: '/mailboxes', label: 'Mailboxes', icon: Inbox },
  { to: '/domains', label: 'Domains', icon: Globe2 },
  { to: '/bridges', label: 'Bridges', icon: Cable },
];

const TOOLS: NavItem[] = [
  { to: '/diagnostics', label: 'Diagnostics', icon: Stethoscope },
  { to: '/me', label: 'You', icon: UserCog },
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
          <Mail className="h-4 w-4" />
        </div>
        <div className="text-sm font-semibold">Polaris Mail</div>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>
      <Section title="Operations" items={OPERATIONS} currentPath={currentPath} />
      <Section title="Configuration" items={CONFIGURATION} currentPath={currentPath} />
      <Section title="Tools" items={TOOLS} currentPath={currentPath} />
    </nav>
  );
}
