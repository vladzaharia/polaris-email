// SidebarLayout — fixed left rail on desktop, Sheet drawer on mobile.
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { AppSidebar } from '../components/AppSidebar.js';
import { Sheet, SheetContent, SheetTrigger } from '../components/ui/sheet.js';
import { Button } from '../components/ui/button.js';

export function SidebarLayout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-screen w-full">
      {/* Skip-link — first focusable element on the page so keyboard users
          can jump past the sidebar. Visually hidden until focused, then
          surfaces as a normal button. (Phase 6c.1) */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-[var(--color-primary)] focus:px-3 focus:py-2 focus:text-sm focus:text-[var(--color-primary-foreground)] focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
      >
        Skip to main content
      </a>
      {/* Desktop sidebar — hidden on small screens. */}
      <aside className="hidden w-64 shrink-0 border-r md:block">
        <AppSidebar />
      </aside>
      {/* Main column. */}
      <div className="flex min-h-screen flex-1 flex-col">
        <header className="flex h-12 items-center gap-2 border-b px-4 md:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open navigation">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-0">
              <AppSidebar />
            </SheetContent>
          </Sheet>
          <div className="text-sm font-semibold">polaris-email</div>
        </header>
        <main id="main" className="flex-1 p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
