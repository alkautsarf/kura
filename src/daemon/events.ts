export interface KuraEvent {
  type: string;
  payload: Record<string, unknown>;
  ts: number;
}

type Subscriber = (event: KuraEvent) => void;

const subscribers = new Set<Subscriber>();
const recent: KuraEvent[] = [];
const RECENT_MAX = 100;

export function emit(type: string, payload: Record<string, unknown> = {}): void {
  const event: KuraEvent = { type, payload, ts: Date.now() };
  recent.push(event);
  if (recent.length > RECENT_MAX) recent.shift();
  for (const s of subscribers) {
    try {
      s(event);
    } catch {
      // subscriber failure must not break the bus
    }
  }
}

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function recentEvents(limit = 50): KuraEvent[] {
  return recent.slice(Math.max(0, recent.length - limit));
}

export function sseStream(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: KuraEvent) => {
        const line = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        try {
          controller.enqueue(encoder.encode(line));
        } catch {
          // controller closed
        }
      };
      controller.enqueue(encoder.encode(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`));
      const unsubscribe = subscribe(send);
      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`event: ping\ndata: ${Date.now()}\n\n`));
        } catch {
          clearInterval(ping);
          unsubscribe();
        }
      }, 25_000);
      (controller as unknown as { _kura_cleanup?: () => void })._kura_cleanup = () => {
        clearInterval(ping);
        unsubscribe();
      };
    },
    cancel() {
      // cleanup attached above runs on cancel via controller close
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
