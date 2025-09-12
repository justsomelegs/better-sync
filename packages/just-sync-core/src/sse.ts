import { ulid } from 'ulid';

export type RingEvent = {
  id: string;
  data: string; // pre-serialized SSE data payload
  ts: number;
};

export class SseRingBuffer {
  private buffer: RingEvent[] = [];
  private maxEvents: number;
  private maxAgeMs: number;
  constructor(opts?: { maxEvents?: number; maxAgeMs?: number }) {
    this.maxEvents = opts?.maxEvents ?? 10_000;
    this.maxAgeMs = opts?.maxAgeMs ?? 60_000;
  }
  push(data: unknown): RingEvent {
    const id = ulid();
    const evt: RingEvent = { id, data: JSON.stringify(data), ts: Date.now() };
    this.buffer.push(evt);
    this.trim();
    return evt;
  }
  getSince(id?: string): RingEvent[] {
    if (!id) return [...this.buffer];
    const idx = this.buffer.findIndex((e) => e.id === id);
    if (idx < 0) return [...this.buffer];
    return this.buffer.slice(idx + 1);
  }
  private trim() {
    const cutoff = Date.now() - this.maxAgeMs;
    while (this.buffer.length > this.maxEvents || (this.buffer[0] && this.buffer[0].ts < cutoff)) {
      this.buffer.shift();
    }
  }
}

export function sseHeaders(): Headers {
  const h = new Headers();
  h.set('Content-Type', 'text/event-stream');
  h.set('Cache-Control', 'no-cache');
  h.set('Connection', 'keep-alive');
  return h;
}

type Subscriber = {
  enqueue: (chunk: Uint8Array) => void;
  close: () => void;
};

export class SseHub {
  private ring: SseRingBuffer;
  private clients = new Set<Subscriber>();
  private heartbeats = new Map<Subscriber, any>();
  constructor(ring?: SseRingBuffer) {
    this.ring = ring ?? new SseRingBuffer();
  }
  subscribe(lastEventId?: string): Response {
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const sub: Subscriber = {
          enqueue: (chunk) => controller.enqueue(chunk),
          close: () => controller.close()
        };
        this.clients.add(sub);
        // Initial keepalive
        sub.enqueue(new TextEncoder().encode(`:keepalive\n\n`));
        // Replay
        const replay = this.ring.getSince(lastEventId);
        for (const evt of replay) {
          const frame = `id: ${evt.id}\n` + `event: mutation\n` + `data: ${evt.data}\n\n`;
          sub.enqueue(new TextEncoder().encode(frame));
        }
        // Heartbeat
        const t = setInterval(() => {
          sub.enqueue(new TextEncoder().encode(`:keepalive\n\n`));
        }, 15000);
        this.heartbeats.set(sub, t);
      },
      cancel: () => {
        // Stream closed by client; find and cleanup
        for (const [sub, timer] of this.heartbeats) {
          clearInterval(timer);
          this.heartbeats.delete(sub);
        }
        this.clients.clear();
      }
    });
    return new Response(stream, { headers: sseHeaders() });
  }
  broadcast(payload: unknown): { id: string } {
    const evt = this.ring.push(payload);
    const frame = new TextEncoder().encode(`id: ${evt.id}\n` + `event: mutation\n` + `data: ${evt.data}\n\n`);
    for (const sub of this.clients) sub.enqueue(frame);
    return { id: evt.id };
  }
}
