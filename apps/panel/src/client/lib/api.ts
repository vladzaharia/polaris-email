// API wrapper.
//
// Thin layer over the panel server's /api/* surface (which itself proxies to
// services/api over a Worker service binding). All requests go through
// `apiFetch`, which translates HTTP 428 (Precondition Required) into a custom
// `StepUpRequiredError` or `ApprovalRequiredError` the UI can catch.
//
// A lightweight global event channel (`stepup:required`) is dispatched on
// `window` whenever a step-up error is thrown; the RootLayout subscribes and
// opens the StepUpModal. This avoids threading a context through every page.
export class StepUpRequiredError extends Error {
  constructor(public readonly stepUpUrl: string) {
    super('step_up_required');
    this.name = 'StepUpRequiredError';
  }
}

export class ApprovalRequiredError extends Error {
  constructor(public readonly action: string) {
    super('approval_required');
    this.name = 'ApprovalRequiredError';
  }
}

export interface StepUpEventDetail {
  stepUpUrl: string;
  retry?: () => void;
}

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  if (res.status === 428) {
    const b = body as { code?: string; step_up_url?: string; action?: string };
    if (b.code === 'step_up_required' && b.step_up_url) {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent<StepUpEventDetail>('stepup:required', {
            detail: { stepUpUrl: b.step_up_url },
          }),
        );
      }
      throw new StepUpRequiredError(b.step_up_url);
    }
    if (b.code === 'approval_required' && b.action) {
      throw new ApprovalRequiredError(b.action);
    }
  }
  return { status: res.status, body: body as T };
}
