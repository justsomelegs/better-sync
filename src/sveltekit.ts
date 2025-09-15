// Minimal SvelteKit integration without depending on @sveltejs/kit types
// Usage in app: export const handle = toSvelteKitHandle(sync.fetch, { basePath: '/api/sync' })

export type SvelteKitHandle = (args: { event: { request: Request }; resolve: (event: any) => Promise<Response> }) => Promise<Response>;

export function toSvelteKitHandle(fetchHandler: (req: Request) => Promise<Response>, opts?: { basePath?: string }): SvelteKitHandle {
  const basePath = (opts?.basePath ?? '/api/sync').replace(/\/$/, '');
  return async ({ event, resolve }) => {
    const url = new URL(event.request.url);
    const pathname = url.pathname;
    if (pathname === basePath || pathname.startsWith(basePath + '/')) {
      // Rewrite URL by stripping basePath so the internal router sees /events, /mutate, etc.
      const trimmed = pathname.slice(basePath.length) || '/';
      const rewritten = new URL(url.toString());
      rewritten.pathname = trimmed;
      const req = new Request(rewritten.toString(), event.request);
      return fetchHandler(req);
    }
    return resolve(event as any);
  };
}

