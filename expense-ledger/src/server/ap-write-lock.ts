// The app runs one process against the AP volume. Manual edits and source
// reconciliation share this lock, including the engine/payment journal step.
let queue: Promise<unknown> = Promise.resolve();
export function withApWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn);
  queue = result.then(() => undefined, () => undefined);
  return result;
}
