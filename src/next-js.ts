export type NextJsHandler = (req: Request) => Promise<Response>;

export function toNextJsHandler(handler: NextJsHandler) {
  return { GET: handler, POST: handler } as const;
}
