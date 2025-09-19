/**
 * Utilities for schema definitions and version upgrades.
 */
/**
 * Create a collection schema with versioning.
 *
 * @param schema - The schema configuration including name, version, parse, and optional upgrade.
 * @returns The provided schema with strong typing.
 *
 * @example
 * const Users = defineCollection({
 *   name: "users",
 *   version: 1,
 *   parse: (x): User => zUser.parse(x),
 * });
 */
export function defineCollection(schema) {
    return schema;
}
/**
 * Compute meta key for a collection schema version.
 */
export function schemaVersionKey(collection) {
    return `schema:${collection}:version`;
}
//# sourceMappingURL=schema.js.map