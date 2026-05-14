// Panel client entrypoint.
//
// Mounts the TanStack Router app inside the providers from RootLayout. The
// router itself wraps every route in <SidebarLayout> via the rootRoute
// component.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRouter } from './router.js';
import './styles.css';

const root = document.getElementById('app');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <AppRouter />
    </StrictMode>,
  );
}
