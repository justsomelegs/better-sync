import type { DatabaseAdapter } from '../shared/types';

export function createSync(_config: { schema: unknown; database: DatabaseAdapter; mutators?: Record<string, unknown> }) {
  const handler = async () => {
    throw new Error('Not implemented');
  };

  const fetch = async (_req: Request): Promise<Response> => {
    return new Response('Not implemented', { status: 501 });
  };

  return {
    handler,
    fetch,
  } as const;
}
