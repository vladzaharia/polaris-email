// API wrapper.
//
// Thin layer over the panel server's /api/* surface (which itself proxies to
// services/api over a Worker service binding). All requests go through
// `apiFetch`, which now throws a typed `ApiError` on any non-2xx response. The
// backend speaks the standard polaris error envelope:
//
//   { error: { code, message, retryable, request_id } }
//
// `apiFetch` falls back gracefully when the body isn't JSON or doesn't match
// the envelope shape — the raw status text becomes the message.
//
// 428 Precondition Required is reserved for the two-person approval flow:
// the server returns `{ code: 'approval_required', action }` when a
// destructive route needs an approved approval-id (see
// `server/auth/approvals.ts`). The panel surfaces this as a regular
// `ApiError` and the calling page is responsible for guiding the operator
// through the approval workflow.

/** Typed error thrown by `apiFetch` on any non-2xx response. */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly requestId: string | null,
    public readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    request_id?: string;
  };
  // Older / non-standard shapes that some endpoints still emit. We pluck
  // values out of these so the typed `ApiError` is as useful as possible.
  code?: string;
  message?: string;
  request_id?: string;
}

function parseErrorBody(
  body: unknown,
  status: number,
): {
  code: string;
  message: string;
  retryable: boolean;
  requestId: string | null;
} {
  const env = (body ?? {}) as ErrorEnvelope;
  const err = env.error ?? {};
  const code = err.code ?? env.code ?? `http_${status}`;
  const message =
    err.message ??
    env.message ??
    (typeof body === 'string' && body.length > 0 ? body : `HTTP ${status}`);
  const retryable = err.retryable ?? (status >= 500 || status === 429);
  const requestId = err.request_id ?? env.request_id ?? null;
  return { code, message, retryable, requestId };
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
  if (!res.ok) {
    const { code, message, retryable, requestId } = parseErrorBody(body, res.status);
    throw new ApiError(code, res.status, requestId, retryable, message);
  }
  return { status: res.status, body: body as T };
}
