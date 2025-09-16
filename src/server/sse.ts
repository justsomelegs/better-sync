export type SseConfig = { keepaliveMs?: number };

export function createSseStream(config?: SseConfig) {
	const subscribers = new Set<(frame: string) => void>();
	const ring: { id: string; frame: string; ts: number }[] = [];

	function pruneRing(now: number, bufferMs: number, cap: number) {
		while (ring.length > 0) {
			const first = ring[0];
			if (!first) break;
			if (now - first.ts > bufferMs) ring.shift(); else break;
		}
		while (ring.length > cap) ring.shift();
	}

	function emit(frame: string, id: string, bufferMs: number, cap: number) {
		ring.push({ id, frame, ts: Date.now() });
		pruneRing(Date.now(), bufferMs, cap);
		for (const send of subscribers) {
			try { send(frame); } catch { }
		}
	}

	function handler(opts: { bufferMs: number; cap: number; lastEventId?: string; signal?: AbortSignal }) {
		let timer: NodeJS.Timeout | null = null;
		let send: ((frame: string) => void) | null = null;
		return new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				const encoder = new TextEncoder();
				controller.enqueue(encoder.encode(':keepalive\n\n'));
				if (opts.lastEventId) {
					const idx = ring.findIndex((e) => e.id === opts.lastEventId);
					if (idx >= 0) {
						for (const e of ring.slice(idx + 1)) controller.enqueue(encoder.encode(e.frame));
					}
				}
				send = (frame: string) => controller.enqueue(encoder.encode(frame));
				subscribers.add(send);
				timer = setInterval(() => controller.enqueue(encoder.encode(':keepalive\n\n')), config?.keepaliveMs ?? 15000);
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

