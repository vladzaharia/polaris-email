// Toaster — re-exports sonner's <Toaster> so RootLayout can mount it once.
import { Toaster as SonnerToaster, type ToasterProps } from 'sonner';

export function Toaster(props: ToasterProps) {
  return <SonnerToaster richColors closeButton {...props} />;
}

export { toast } from 'sonner';
