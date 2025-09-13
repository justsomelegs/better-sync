import "../chunk-V6TY7KAL.js";

// src/next-js/index.ts
function toNextJsHandler(handler) {
  return {
    GET: (req) => handler(req),
    POST: (req) => handler(req)
  };
}
export {
  toNextJsHandler
};
//# sourceMappingURL=index.js.map