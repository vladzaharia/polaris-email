// Swizzled SearchBar — backed by Pagefind instead of Algolia.
//
// The Pagefind index is produced post-build by `pagefind --site build` and
// lands under `build/pagefind/`. We pull the UI bundle lazily on first
// focus so it doesn't show up in the initial JS payload — the docs site
// renders fine without it.
//
// The component is intentionally tiny: it owns a single mount node and
// hands control to Pagefind's default UI. Visual theming is driven from
// the --pagefind-ui-* CSS variables in src/css/custom.css.
import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import { useColorMode } from '@docusaurus/theme-common';
import clsx from 'clsx';

// Pagefind's default-ui module is loaded at runtime from the built site,
// not bundled at compile time. Declaring `window.PagefindUI` keeps the
// types happy without dragging a Node-only types package into the browser
// bundle.
declare global {
  interface Window {
    PagefindUI?: new (opts: {
      element: string | HTMLElement;
      bundlePath?: string;
      showImages?: boolean;
      resetStyles?: boolean;
      excerptLength?: number;
      processResult?: (r: unknown) => unknown;
    }) => void;
  }
}

export default function SearchBar(): ReactElement {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const { colorMode } = useColorMode();
  // Pagefind serves its UI assets out of /pagefind/ on the deployed site.
  // useBaseUrl honors a non-root baseUrl for completeness.
  const bundlePath = useBaseUrl('/pagefind/');

  // Lazy-load the Pagefind UI bundle on first open. The script + styles
  // live next to the index under /pagefind/. Once injected they stay.
  const loadPagefind = useCallback(async () => {
    if (window.PagefindUI) {
      setReady(true);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${bundlePath}pagefind-ui.js`;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('pagefind-ui.js failed to load'));
      document.head.appendChild(script);

      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `${bundlePath}pagefind-ui.css`;
      document.head.appendChild(link);
    }).catch((err) => {
      // The first build never has the index — keep the input usable so we
      // don't blow up dev. A 404 here is expected in `docusaurus start`
      // unless the operator ran `pagefind --site build` already.
      console.warn('[polaris-docs] Pagefind UI not available yet:', err);
    });
    setReady(true);
  }, [bundlePath]);

  // Mount the UI exactly once when the dialog opens and the bundle is in
  // place. Calling `new PagefindUI` more than once on the same node would
  // produce duplicate inputs.
  useEffect(() => {
    if (!open || !ready || !mountRef.current) return;
    if (!window.PagefindUI) return;
    if (mountRef.current.dataset.mounted === '1') return;
    mountRef.current.dataset.mounted = '1';
    new window.PagefindUI({
      element: mountRef.current,
      bundlePath,
      showImages: false,
      excerptLength: 30,
    });
  }, [open, ready, bundlePath]);

  // Cmd/Ctrl-K is the de-facto keystroke for site search. Wire it once
  // and let the dialog handle ESC to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        void loadPagefind();
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [loadPagefind]);

  return (
    <div className={clsx('navbar__search', `theme-${colorMode}`)}>
      <button
        type="button"
        className="navbar__search-input"
        aria-label="Search docs (⌘K)"
        onClick={() => {
          setOpen(true);
          void loadPagefind();
        }}
        style={{
          background: 'var(--ifm-color-emphasis-100)',
          color: 'var(--ifm-color-emphasis-700)',
          border: '1px solid var(--ifm-toc-border-color)',
          borderRadius: 'var(--ifm-global-radius)',
          padding: '0.4rem 0.7rem',
          font: 'inherit',
          cursor: 'pointer',
          minWidth: '12rem',
          textAlign: 'left',
        }}
      >
        Search docs…{' '}
        <span aria-hidden="true" style={{ opacity: 0.6, marginLeft: '0.5rem' }}>
          ⌘K
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Search"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.45)',
            backdropFilter: 'blur(4px)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            paddingTop: '10vh',
          }}
        >
          <div
            style={{
              background: 'var(--ifm-background-surface-color)',
              border: '1px solid var(--ifm-toc-border-color)',
              borderRadius: 'var(--ifm-card-border-radius)',
              padding: '1rem',
              width: 'min(640px, 92vw)',
              maxHeight: '70vh',
              overflow: 'auto',
              boxShadow: '0 16px 32px -8px oklch(0 0 0 / 0.55)',
            }}
          >
            <div ref={mountRef} className="pagefind-ui" />
            {!ready && (
              <p style={{ color: 'var(--ifm-color-content-secondary)', margin: 0 }}>
                Loading search index…
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
