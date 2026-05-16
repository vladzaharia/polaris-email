// PageSkeleton — placeholder shown while a lazy route module loads. Wired
// onto every panel route via TanStack Router's `pendingComponent`. Keeps
// the layout chrome stable so navigation feels instant even when the
// chunk is cold. (Phase 6d.8)
import { Skeleton } from './ui/skeleton.js';

export function PageSkeleton() {
  return (
    <div className="space-y-4 p-2">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-72" />
      <Skeleton className="mt-6 h-32 w-full" />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    </div>
  );
}
