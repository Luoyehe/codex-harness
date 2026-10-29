export type FixtureCleanup = (cleanup: () => void | Promise<void>) => void;

/** Own resources for the entire fixture, including fallible setup. */
export async function withFixtureCleanup<T>(body: (defer: FixtureCleanup) => Promise<T>): Promise<T> {
  const cleanups: (() => void | Promise<void>)[] = [];
  let result!: T, failed = false, failure: unknown;
  try { result = await body(cleanup => { cleanups.push(cleanup); }); }
  catch (error) { failed = true; failure = error; }
  const errors: unknown[] = [];
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(failed ? [failure, ...errors] : errors, 'Fixture cleanup was not fully confirmed', { cause: failed ? failure : errors[0] });
  if (failed) throw failure;
  return result;
}
