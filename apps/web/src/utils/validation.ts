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

/** Caddy's domain field is a host only; scheme, path, query and embedded port
 * are configured elsewhere and must not be smuggled into the generated site
 * address. IPv6 literals in brackets are accepted by URL parsing. */
export function validatedHostname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (!input || input.length > 253 || /\s/.test(input)) return null;
  try {
    const parsed = new URL(`https://${input}`);
    if (
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) return null;
    return input;
  } catch {
    return null;
  }
}

export function clampedInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
