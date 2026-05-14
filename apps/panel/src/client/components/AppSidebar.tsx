// AppSidebar — left-rail navigation, grouped into Operations / Configuration
// / Diagnostics. Used by SidebarLayout both as the desktop fixed rail and as
// the Sheet body on mobile.
import { Link } from '@tanstack/react-router';
import {
  Activity,
  AtSign,
  BarChart3,
  Globe2,
  Inbox,
  Key,
  LayoutDashboard,
  Mail,
  Route,
  ServerCog,
  Settings,
  Stethoscope,
  Webhook,
} from 'lucide-react';
import { cn } from '../lib/cn.js';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const OPERATIONS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/messages', label: 'Messages', icon: Mail },
  { to: '/test-send', label: 'Test send', icon: Activity },
  { to: '/dlq', label: 'DLQ browser', icon: BarChart3 },
];

const CONFIGURATION: NavItem[] = [
  { to: '/mailboxes', label: 'Mailboxes', icon: Inbox },
  { to: '/domains', label: 'Domains', icon: Globe2 },
  { to: '/credentials', label: 'Credentials', icon: Key },
  { to: '/webhook-subs', label: 'Webhook subs', icon: Webhook },
  { to: '/routing', label: 'Routing', icon: Route },
];

const DIAGNOSTICS: NavItem[] = [
  { to: '/daemons', label: 'Daemons', icon: ServerCog },
  { to: '/settings/account', label: 'Account', icon: AtSign },
  { to: '/diagnostics', label: 'Diagnostics', icon: Stethoscope },
];

function Section({ title, items }: { title: string; items: NavItem[] }) {
  return (
    <div className="px-3 py-2">
      <div className="px-2 pb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-sidebar-foreground)]/60">
        {title}
      </div>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.to}>
            <Link
              to={item.to}
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
        ))}
      </ul>
    </div>
  );
}

export function AppSidebar() {
  return (
    <nav className="flex h-full flex-col gap-1 bg-[var(--color-sidebar)] text-[var(--color-sidebar-foreground)]">
      <div className="flex items-center gap-2 px-5 py-4">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-[var(--color-primary)] text-[var(--color-primary-foreground)]">
          <Settings className="h-4 w-4" />
        </div>
        <div className="text-sm font-semibold">polaris-email</div>
      </div>
      <Section title="Operations" items={OPERATIONS} />
      <Section title="Configuration" items={CONFIGURATION} />
      <Section title="Diagnostics" items={DIAGNOSTICS} />
    </nav>
  );
}
