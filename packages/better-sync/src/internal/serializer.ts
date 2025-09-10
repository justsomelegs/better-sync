/** Internal model serializer interface used at the storage boundary. */
export interface ModelSerializer<TWire = any, TRow = any> {
  encode(row: TRow): TWire;          // app/db → wire (JSON-safe)
  decode(wire: TWire): TRow;          // wire → app/db
  wireVersion?: number;               // bump if the wire shape changes
}

/** Recommended default conversions (doc only):
 * - uuid → string
 * - bigint/numeric/decimal → string
 * - timestamp/timestamptz → ISO 8601 string
 * - bytea/binary → base64 string
 * - arrays → JSON arrays
 */
export const __serializerDocHint = true;
