const MAX_URL_LENGTH = 2_048;

/** Validate an absolute HTTP(S) URL without accepting executable schemes or
 * credentials hidden in the authority component. The original trimmed value
 * is returned so provider-specific path/query spelling is preserved. */
export function validatedHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (!input || input.length > MAX_URL_LENGTH) return null;
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname || parsed.username || parsed.password || parsed.hash) return null;
    return input;
  } catch {
    return null;
  }
}

/** Provider base URLs may contain a path such as /v1, but query parameters
 * are not part of the stable endpoint identity and the gateway rejects them.
 * Keep this stricter than ordinary clickable HTTP links. */
export function validatedApiBaseUrl(value: unknown): string | null {
  const input = validatedHttpUrl(value);
  if (!input) return null;
  return new URL(input).search ? null : input;
}
