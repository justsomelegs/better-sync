## App-wide typing with module augmentation

To get full IntelliSense across tables and mutators without generics, add a single type-only file.

```ts
// sync-env.d.ts (ensure included by tsconfig)
import type { schema } from './server/schema';
import type { sync } from './server/sync';

declare module 'just-sync' {
  interface AppTypes {
    Schema: typeof schema;
    Mutators: typeof sync['mutators'];
  }
}
```

Notes:
- This file should be compiled for types only (no runtime import).
- After defining this, `createClient({ baseURL })` infers table names, row types, and mutator signatures.

