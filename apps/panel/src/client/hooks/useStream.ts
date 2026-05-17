// useStream — SSE hook used by /test-send to surface per-recipient delivery
// events as they happen.
//
// Phase 6d.2: `EventSource.onmessage` only fires for default (unnamed)
// events, but the test-send stream emits NAMED events (`event: queued`,
// `event: sending`, `event: sent`, `event: delivered`, `event: failed`,
// `event: bounced`, `event: error`, `event: close`). To receive them we
// register a `addEventListener(name, handler)` for each known name
// the dispatcher in the platform routes the SSE `event: foo\n` line to
// the handler keyed on `'foo'`.
import { useEffect, useRef, useState } from 'react';

export interface StreamEvent<T = unknown> {
  event: string;
  data: T;
}

// Known SSE event names emitted by the panel's test-send stream. Adding a
// new server-side event? List it here so `useStream` subscribes.
const KNOWN_EVENTS = [
  'queued',
  'sending',
  'sent',
  'delivered',
  'failed',
  'bounced',
  'error',
  'close',
] as const;

export function useStream<T = unknown>(
  url: string | null,
): {
  events: StreamEvent<T>[];
  status: 'idle' | 'open' | 'closed' | 'error';
  reset: () => void;
} {
  const [events, setEvents] = useState<StreamEvent<T>[]>([]);
  const [status, setStatus] = useState<'idle' | 'open' | 'closed' | 'error'>('idle');
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!url) return;
    const es = new EventSource(url, { withCredentials: true });
    esRef.current = es;
    es.onopen = () => setStatus('open');
    es.onerror = () => setStatus('error');

    const append = (name: string) => (msg: MessageEvent) => {
      let data: T;
      try {
        data = JSON.parse(msg.data);
      } catch {
        data = msg.data as T;
      }
      setEvents((prev) => [...prev, { event: name, data }]);
      if (name === 'close') {
        es.close();
        setStatus('closed');
      }
    };

    // Register one handler per known event name so SSE messages with
    // `event: <name>` reach our consumer. Default `onmessage` stays bound
    // for any unnamed payloads the server might emit (today: none).
    const handlers = KNOWN_EVENTS.map((name) => {
      const h = append(name);
      es.addEventListener(name, h as EventListener);
      return [name, h] as const;
    });
    es.onmessage = append('message');

    return () => {
      for (const [name, h] of handlers) {
        es.removeEventListener(name, h as EventListener);
      }
      es.close();
      setStatus('closed');
    };
  }, [url]);

  return {
    events,
    status,
    reset: () => setEvents([]),
  };
}
