/**
 * Browser object URLs need explicit ownership. The Composer keeps a preview
 * while a draft is retryable and the optimistic timeline keeps a separate
 * owner after submission. A URL is revoked only after the last owner releases
 * it, and each owner can be released safely more than once.
 */

const owners = new WeakMap<object, string>();
const releasedOwners = new WeakSet<object>();
const references = new Map<string, number>();

// Untracked runtime-shaped timeline items can still contain a tab-local blob
// URL. Keep a small tombstone window so duplicate references are not revoked
// repeatedly. Real object URLs are unique; the cap prevents bookkeeping from
// becoming a second lifetime leak.
const revoked = new Set<string>();
const MAX_REVOKED_TOMBSTONES = 4_096;

function isObjectUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("blob:") && value.length <= 4_096;
}

function rememberRevoked(url: string): void {
  revoked.delete(url);
  revoked.add(url);
  while (revoked.size > MAX_REVOKED_TOMBSTONES) {
    const oldest = revoked.values().next().value;
    if (typeof oldest !== "string") break;
    revoked.delete(oldest);
  }
}

function revoke(url: string): void {
  if (revoked.has(url)) return;
  try { URL.revokeObjectURL(url); } catch { /* URL may be unavailable during teardown. */ }
  rememberRevoked(url);
}

/** Register one concrete owner of a newly created or transferred object URL. */
export function retainPreviewUrl(owner: object, url: unknown): void {
  if (!isObjectUrl(url)) return;
  const previous = owners.get(owner);
  if (previous === url) return;
  if (previous) releasePreviewUrl(owner, previous);
  // A real browser does not recycle object URL strings, but clearing a stale
  // tombstone here also makes deterministic test/browser shims safe to reuse.
  if (!references.has(url)) revoked.delete(url);
  releasedOwners.delete(owner);
  owners.set(owner, url);
  references.set(url, (references.get(url) ?? 0) + 1);
}

/**
 * Release a concrete owner exactly once. `fallbackUrl` lets old/runtime-shaped
 * optimistic items participate safely even if they predate registration.
 */
export function releasePreviewUrl(owner: object, fallbackUrl?: unknown): void {
  if (releasedOwners.has(owner)) return;
  releasedOwners.add(owner);
  const owned = owners.get(owner);
  if (owned) owners.delete(owner);
  const url = owned ?? (isObjectUrl(fallbackUrl) ? fallbackUrl : undefined);
  if (!url) return;

  const count = references.get(url);
  if (count !== undefined) {
    if (count > 1) references.set(url, count - 1);
    else {
      references.delete(url);
      revoke(url);
    }
    return;
  }
  // Runtime-shaped state inserted before ownership registration has one
  // implicit owner. Tombstones make repeated aliases idempotent.
  revoke(url);
}

/** Clone an attachment so the optimistic timeline owns a distinct reference. */
export function retainTimelineAttachment<T extends object>(attachment: T): T {
  const clone = { ...attachment };
  retainPreviewUrl(clone, (clone as { previewUrl?: unknown }).previewUrl);
  return clone;
}
