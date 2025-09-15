import { x as ensure_array_like, v as pop, t as push } from "../../chunks/index.js";
import { createClient } from "just-sync";
import { e as escape_html } from "../../chunks/escaping.js";
import "clsx";
const replacements = {
  translate: /* @__PURE__ */ new Map([
    [true, "yes"],
    [false, "no"]
  ])
};
function attr(name, value, is_boolean = false) {
  if (value == null || !value && is_boolean) return "";
  const normalized = name in replacements && replacements[name].get(value) || value;
  const assignment = is_boolean ? "" : `="${escape_html(normalized, true)}"`;
  return ` ${name}${assignment}`;
}
createClient({ baseURL: "/api/sync" });
function _page($$payload, $$props) {
  push();
  let todos = [];
  let title = "";
  $$payload.out.push(`<main class="svelte-1uha8ag"><h1 class="svelte-1uha8ag">just-sync · SvelteKit (Svelte 5) example</h1> <form style="margin-bottom: 1rem;"><input placeholder="New todo title"${attr("value", title)} class="svelte-1uha8ag"/> <button type="submit" class="svelte-1uha8ag">Add</button></form> `);
  if (todos.length) {
    $$payload.out.push("<!--[-->");
    const each_array = ensure_array_like(todos);
    $$payload.out.push(`<ul class="svelte-1uha8ag"><!--[-->`);
    for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
      let t = each_array[$$index];
      $$payload.out.push(`<li class="svelte-1uha8ag"><input type="checkbox"${attr("checked", t.done, true)} class="svelte-1uha8ag"/> ${escape_html(t.title)} <button style="margin-left: .5rem" class="svelte-1uha8ag">Delete</button></li>`);
    }
    $$payload.out.push(`<!--]--></ul>`);
  } else {
    $$payload.out.push("<!--[!-->");
    $$payload.out.push(`<p>No todos yet.</p>`);
  }
  $$payload.out.push(`<!--]--></main>`);
  pop();
}
export {
  _page as default
};
