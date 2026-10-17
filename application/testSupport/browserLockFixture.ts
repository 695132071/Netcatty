/** Serialized Web Locks fixture for tests with a simulated browser window. */
export function installBrowserLockFixture(): void {
  const tails = new Map<string, Promise<void>>();
  const locks = {
    async request<T>(name: string, task: () => Promise<T>): Promise<T> {
      const previous = tails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => gate);
      tails.set(name, tail);
      await previous;
      try {
        return await task();
      } finally {
        release();
        if (tails.get(name) === tail) tails.delete(name);
      }
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks },
  });
}
