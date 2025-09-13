export function toNextJsHandler(handler: (req: Request) => Promise<Response>) {
  return {
    GET: (req: Request) => handler(req),
    POST: (req: Request) => handler(req),
  } as const;
}

