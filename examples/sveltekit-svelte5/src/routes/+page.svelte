<script lang="ts">
  import { onMount } from 'svelte';
  import { client } from '$lib/syncClient';

  type Todo = { id: string; title: string; done: boolean; updatedAt: number };
  let todos: Todo[] = [];
  let title = '';
  let sub: (() => void) | null = null;

  async function loadInitial() {
    const { data } = await client.todos.select({ limit: 50 });
    todos = data as Todo[];
  }

  async function addTodo() {
    if (!title.trim()) return;
    await client.todos.insert({ title, done: false });
    title = '';
  }

  onMount(() => {
    loadInitial();
    sub = client.todos.watch(({ pks }) => {
      // naive re-load on mutation affecting todos
      loadInitial();
    });
    return () => { sub?.(); };
  });
</script>

<main>
  <h1>just-sync · SvelteKit (Svelte 5) example</h1>

  <form on:submit|preventDefault={addTodo} style="margin-bottom: 1rem;">
    <input placeholder="New todo title" bind:value={title} />
    <button type="submit">Add</button>
  </form>

  {#if todos.length}
    <ul>
      {#each todos as t}
        <li>
          <input type="checkbox" checked={t.done} on:change={() => client.todos.update(t.id, { done: !t.done })} />
          {t.title}
          <button on:click={() => client.todos.delete(t.id)} style="margin-left: .5rem">Delete</button>
        </li>
      {/each}
    </ul>
  {:else}
    <p>No todos yet.</p>
  {/if}
</main>

<style>
  main { font-family: system-ui, sans-serif; padding: 2rem; }
  input[type="text"], input:not([type]) { padding: .4rem; }
  button { padding: .4rem .6rem; }
  ul { list-style: none; padding: 0; }
  li { margin: .25rem 0; }
  h1 { margin: 0 0 1rem; font-size: 1.25rem; }
</style>

