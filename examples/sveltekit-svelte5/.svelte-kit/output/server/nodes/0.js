

export const index = 0;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/fallbacks/layout.svelte.js')).default;
export const imports = ["_app/immutable/nodes/0.BX5fQb4a.js","_app/immutable/chunks/Bzak7iHL.js","_app/immutable/chunks/DJAmPjUu.js"];
export const stylesheets = [];
export const fonts = [];
