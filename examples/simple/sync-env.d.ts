import type { schema } from './schema';
declare module '@sync/client' {
  interface AppTypes {
    Schema: typeof schema;
    Mutators: {};
  }
}
