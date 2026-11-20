/** Accepted spellings of the draft implemented by both form validators. */
export function supportsFormDialect(declaration: unknown): boolean {
  return declaration === undefined || (typeof declaration === 'string' &&
    /^https?:\/\/json-schema\.org\/draft-07\/schema#?$/.test(declaration));
}
