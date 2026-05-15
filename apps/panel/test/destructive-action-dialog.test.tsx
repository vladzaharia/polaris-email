// DestructiveActionDialog tests.
//
// The panel test harness runs in `node` without jsdom, so we can't mount React
// or click buttons. We assert on what we CAN check without a DOM:
//   1. The component is importable, has the expected prop surface.
//   2. The typed-confirmation gating logic — extracted into a pure helper for
//      this test — accepts the exact string and rejects everything else.
//   3. `react-dom/server` can serialise an `open={false}` instance without
//      throwing (sanity: the component is well-formed JSX).
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DestructiveActionDialog } from '../src/client/components/DestructiveActionDialog.js';

// Pure gating helper — mirrors the inline check in DestructiveActionDialog so
// we can exercise it without mounting Radix. If this drifts from the
// component, the typed-confirmation contract is broken.
function gateConfirm(typed: string, expected: string | undefined, isPending: boolean) {
  const typedOk = !expected || typed === expected;
  return !isPending && typedOk;
}

describe('DestructiveActionDialog', () => {
  it('exports a component with the documented props shape', () => {
    expect(typeof DestructiveActionDialog).toBe('function');
    // Construct a React element to confirm the type accepts the documented
    // props without TS complaint. (Type errors would surface at the panel
    // typecheck step; this is a runtime smoke.)
    const el = createElement(DestructiveActionDialog, {
      open: false,
      onOpenChange: () => {},
      action: 'Revoke credential',
      name: 'smtp-acme-noreply',
      blastRadius: ['Active sessions rejected'],
      typedConfirmation: 'smtp-acme-noreply',
      onConfirm: () => {},
    });
    expect(el).toBeTruthy();
  });

  it('renders to an empty fragment when closed (Radix portal gated by `open`)', () => {
    // Radix Dialog renders no markup when `open` is false. We use SSR here so
    // we don't need a DOM; `renderToStaticMarkup` exercises the component tree
    // far enough to confirm the closed-state contract holds.
    const out = renderToStaticMarkup(
      createElement(DestructiveActionDialog, {
        open: false,
        onOpenChange: () => {},
        action: 'Drop entry',
        onConfirm: () => {},
      }),
    );
    expect(out).toBe('');
  });

  describe('typed-confirmation gating', () => {
    it('disables confirm until the exact string is typed', () => {
      expect(gateConfirm('', 'smtp-acme', false)).toBe(false);
      expect(gateConfirm('smtp-ac', 'smtp-acme', false)).toBe(false);
      expect(gateConfirm('smtp-acme ', 'smtp-acme', false)).toBe(false); // trailing space
      expect(gateConfirm('SMTP-ACME', 'smtp-acme', false)).toBe(false); // wrong case
    });

    it('enables confirm on exact match', () => {
      expect(gateConfirm('smtp-acme', 'smtp-acme', false)).toBe(true);
    });

    it('always enables confirm when no typed-confirmation is required', () => {
      expect(gateConfirm('', undefined, false)).toBe(true);
      expect(gateConfirm('anything', undefined, false)).toBe(true);
    });

    it('keeps confirm disabled while the mutation is pending, even on a match', () => {
      expect(gateConfirm('smtp-acme', 'smtp-acme', true)).toBe(false);
      expect(gateConfirm('', undefined, true)).toBe(false);
    });
  });
});
