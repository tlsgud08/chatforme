const pending = new Map<string, Promise<unknown>>();

/** Share concurrent reads only; settled data is never cached. */
export function shareInFlight<T>(key: string, read: () => PromiseLike<T>): Promise<T> {
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;
  const promise = Promise.resolve().then(read);
  pending.set(key, promise);
  const clear = () => { if (pending.get(key) === promise) pending.delete(key); };
  void promise.then(clear, clear);
  return promise;
}

export function invalidateInFlight(prefix: string): void {
  for (const key of pending.keys()) if (key.startsWith(prefix)) pending.delete(key);
}
