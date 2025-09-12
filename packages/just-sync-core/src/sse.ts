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
