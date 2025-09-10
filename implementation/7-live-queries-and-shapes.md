## Live Queries & Shapes

### Objective
Explain live query subscriptions and server-managed partial replication shapes.

### Details
#### Live queries (framework-agnostic)
```ts
const sub = sync.subscribeQuery({ model: "todo", where: { done: false }, select: ["id", "title"] }, (rows) => {
  // typed rows
});
sub.unsubscribe();
```
- Uses WS "poke" with HTTP fallback; server validates queries and ACLs.

#### Partial replication shapes
```ts
await server.api.registerShape({ tenantId: "t1", model: "todo", where: { archived: false }, select: ["id", "title", "updated_at"] });
// Client can pin shapes: sync.pinShape(shapeId)
```
- Per-tenant cursors per shape; client cache invalidates on shape changes.

#### For beginners:
- A "shape" is a saved rule for which rows and fields to sync. It keeps bandwidth and local DB small.

### MVP (Phase 1)
- Subscribe/unsubscribe; server-validated queries; register/pin shapes; per-tenant shape cursors.

### Phase 2 / Future
- Query planners and caching strategies; UI bindings for popular frameworks.

### Dependencies
- Protocol & Transport; Security & Multi-tenancy; Storage & Adapters.

### Notes
- Keep live queries framework-agnostic; add thin wrappers later.
