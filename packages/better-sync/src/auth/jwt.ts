export function jwt(options: { jwksUrl: string }) {
  return { type: "jwt", options } as const;
}
