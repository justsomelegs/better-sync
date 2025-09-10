/** Common serializer helpers for JSON-safe wire formats.
 * Compose them per model in createClient to keep a single source of truth for types.
 */
import type { ModelSerializer } from "./types.js";

type KeysOfType<T, U> = { [K in keyof T]-?: T[K] extends U ? K : never }[keyof T];
type TransformFields<T, K extends keyof T, From, To> = {
  [P in keyof T]: P extends K ? (T[P] extends From ? To : T[P]) : T[P]
};

/** Pass-through serializer for already JSON-safe rows. */
export function passthrough<T>(): ModelSerializer<T, T> {
  return { encode: (row) => row, decode: (wire) => wire } as const;
}

/** Serialize bigint fields to string and back using provided field keys. */
export function bigIntFields<TRow extends Record<string, any>, K extends ReadonlyArray<KeysOfType<TRow, bigint>>>(
  ...keys: K
): ModelSerializer<TransformFields<TRow, K[number], bigint, string>, TRow> {
  return {
    encode(row) {
      const out: any = { ...row };
      for (const k of keys) if (typeof out[k] === "bigint") out[k] = (out[k] as bigint).toString();
      return out;
    },
    decode(wire) {
      const out: any = { ...wire };
      for (const k of keys) if (typeof out[k] === "string") out[k] = BigInt(out[k]);
      return out;
    },
  } as const;
}

/** Serialize Date fields to ISO 8601 and back using provided field keys. */
export function dateFields<TRow extends Record<string, any>, K extends ReadonlyArray<KeysOfType<TRow, Date>>>(
  ...keys: K
): ModelSerializer<TransformFields<TRow, K[number], Date, string>, TRow> {
  return {
    encode(row) {
      const out: any = { ...row };
      for (const k of keys) if (out[k] instanceof Date) out[k] = (out[k] as Date).toISOString();
      return out;
    },
    decode(wire) {
      const out: any = { ...wire };
      for (const k of keys) if (typeof out[k] === "string") out[k] = new Date(out[k]);
      return out;
    },
  } as const;
}

/** Compose multiple serializers; encode runs left→right, decode runs right→left. */
export function compose<TRow>(
  ...list: Array<ModelSerializer<unknown, TRow>>
): ModelSerializer<unknown, TRow> {
  return {
    encode(row: any) { return list.reduce((acc, s) => s.encode(acc), row); },
    decode(wire: any) { return list.reduceRight((acc, s) => s.decode(acc), wire); },
  } as const;
}
