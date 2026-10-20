type OpenTerminalTask = () => Promise<void> | void;

function isPromise(value: Promise<void> | void): value is Promise<void> {
  return Boolean(value) && typeof (value as Promise<void>).then === 'function';
}

/**
 * Ordered launcher queue. An idle queue runs the task in the caller turn so a
 * path-only open still creates its tab synchronously. A task that awaits (shell
 * discovery) holds the tail, and later requests cannot pass it.
 */
export function createOpenTerminalQueue() {
  let tail: Promise<void> = Promise.resolve();
  let depth = 0;

  return {
    enqueue(task: OpenTerminalTask): Promise<void> {
      depth += 1;
      let release: () => void;
      const finished = new Promise<void>((resolve) => {
        release = () => {
          depth -= 1;
          resolve();
        };
      });
      const previous = tail;
      tail = finished;

      const run = (): Promise<void> => {
        try {
          const result = task();
          if (isPromise(result)) {
            return result.then(release, (error: unknown) => {
              release();
              throw error;
            });
          }
          release();
          return Promise.resolve();
        } catch (error) {
          release();
          throw error;
        }
      };

      if (depth === 1) return run();
      return previous.then(run, run);
    },
  };
}
