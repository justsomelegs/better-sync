import { createClient } from '@sync/client';

export const client = createClient({ baseURL: 'http://localhost:8787' });

async function demo() {
  await client.todos.insert({ title: 'Buy milk', done: false });
  const sub = client.todos.watch({ orderBy: { updatedAt: 'desc' }, limit: 50 }, ({ data }) => {
    console.log('Todos', data);
  });
  setTimeout(() => sub.unsubscribe(), 5000);
}

demo();
