import { responseFromError } from '../shared/errors';

export function withRequestId(handler: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      const res = await handler(req);
      return res;
    } catch (e) {
      const rid = req.headers.get('X-Request-Id') || crypto.randomUUID?.() || '';
      return responseFromError(e, { requestId: rid });
    }
  };
}

