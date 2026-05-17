/**
 * Run `fn` against every item in parallel, bounded to `batchSize` concurrent
 * invocations. Used by the per-domain cron handlers
 * (mta-sts-continuity, dkim-self-verify) so an operator with 100 domains
 * doesn't pay for 100 sequential 5s timeouts.
 *
 * The DoH client expects ~1 RPS per source; 10 concurrent calls keeps us
 * inside Cloudflare's DoH rate-limit envelope even on a tail of slow
 * resolvers.
 */
export async function runBatched<T, R>(
  items: readonly T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const slice = items.slice(i, i + batchSize);
    const results = await Promise.all(slice.map(fn));
    out.push(...results);
  }
  return out;
}
