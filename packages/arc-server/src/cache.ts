/** Tiny TTL cache. Arc's public RPC rate-limits, so repeat requests must not reach it. */
export class Cache {
  #entries = new Map<string, { value: unknown; expires: number }>();
  #inflight = new Map<string, Promise<unknown>>();

  /**
   * Return the cached value, or compute it. Concurrent callers for the same key
   * share one computation, so a page load with four widgets makes one RPC pass.
   */
  async wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.#entries.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as T;

    const running = this.#inflight.get(key);
    if (running) return running as Promise<T>;

    const promise = (async () => {
      try {
        const value = await fn();
        this.#entries.set(key, { value, expires: Date.now() + ttlMs });
        return value;
      } finally {
        this.#inflight.delete(key);
      }
    })();

    this.#inflight.set(key, promise);
    return promise as Promise<T>;
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }
}
