import { createClient } from 'just-sync';

export const client = createClient({ baseURL: '/api/sync' });

