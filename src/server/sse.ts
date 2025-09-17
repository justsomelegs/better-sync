export type SseConfig = { keepaliveMs?: number };

export function createSseStream(config?: SseConfig) {
	const encoder = new TextEncoder();
	const KEEPALIVE = encoder.encode(':keepalive\n\n');
	const RECOVER = encoder.encode('event: recover\ndata: {}\n\n');
	const subscribers = new Set<(frame: Uint8Array) => void>();
	const ring: { id: string; frame: Uint8Array; ts: number }[] = [];

	function pruneRing(now: number, bufferMs: number, cap: number) {
		while (ring.length > 0) {
			const first = ring[0];
			if (!first) break;
			if (now - first.ts > bufferMs) ring.shift(); else break;
		}
		while (ring.length > cap) ring.shift();
	}

	function emit(frame: string, id: string, bufferMs: number, cap: number) {
		const bytes = encoder.encode(frame);
		ring.push({ id, frame: bytes, ts: Date.now() });
		pruneRing(Date.now(), bufferMs, cap);
		for (const send of subscribers) { try { send(bytes); } catch { } }
	}

	function handler(opts: { bufferMs: number; cap: number; lastEventId?: string; signal?: AbortSignal; debug?: boolean }) {
		let timer: NodeJS.Timeout | null = null;
		let send: ((frame: string) => void) | null = null;
		return new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(KEEPALIVE);
				if (opts.lastEventId) {
					const idx = ring.findIndex((e) => e.id === opts.lastEventId);
					if (idx >= 0) {
						for (const e of ring.slice(idx + 1)) controller.enqueue(e.frame);
						if (opts.debug) { try { console.debug('[just-sync] SSE replay', ring.length - (idx + 1)); } catch {} }
					} else {
						// Signal resume miss so clients can perform a fresh snapshot
						controller.enqueue(RECOVER);
					}
				}
				send = (frame: Uint8Array) => controller.enqueue(frame);
				subscribers.add(send);
				timer = setInterval(() => controller.enqueue(KEEPALIVE), config?.keepaliveMs ?? 15000);
				if (opts.signal) {
					opts.signal.addEventListener('abort', () => {
						if (timer) clearInterval(timer);
						if (send) subscribers.delete(send);
						try { controller.close(); } catch { }
					});
				}
			},
			cancel() {
				if (timer) clearInterval(timer);
				if (send) subscribers.delete(send);
			}
		}), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' } });
	}

	return { emit, handler, ring, subscribers } as const;
}

