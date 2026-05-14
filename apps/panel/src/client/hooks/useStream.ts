// useStream — SSE hook used by /test-send to surface per-recipient delivery
// events as they happen. Phase I will flesh this out; for now it's a typed
// EventSource wrapper.
import { useEffect, useRef, useState } from 'react';

export interface StreamEvent<T = unknown> {
  event: string;
  data: T;
}

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
    es.onmessage = (msg) => {
      let data: T;
      try {
        data = JSON.parse(msg.data);
      } catch {
        data = msg.data as T;
      }
      setEvents((prev) => [...prev, { event: msg.type || 'message', data }]);
    };
    return () => {
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
