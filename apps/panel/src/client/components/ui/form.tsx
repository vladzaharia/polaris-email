// Form primitive — TanStack Form's `createFormHook` factory in Phase I.
// For now we expose the raw `useForm` hook so consumers can wire their own
// state without conflicting with React Hook Form (which shadcn's default
// `form.tsx` uses). TanStack was chosen instead per the panel spec.
export { useForm } from '@tanstack/react-form';
