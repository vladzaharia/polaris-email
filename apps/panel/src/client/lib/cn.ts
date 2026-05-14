// `cn` — the shadcn classname helper: clsx + tailwind-merge. Keeps the last
// conflicting Tailwind utility in a class string (so `px-4` overrides `p-2`).
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
