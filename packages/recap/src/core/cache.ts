/** Share active requests and retain only a bounded number of completed results. */
export function generationCache<T>(limit = 128) {
  const active = new Map<
    string,
    { request: Promise<T>; controller: AbortController; readers: number }
  >();
  const completed = new Map<string, T>();
  return (
    key: string,
    generate: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (completed.has(key)) return Promise.resolve(completed.get(key)!);
    let pending = active.get(key);
    if (!pending) {
      const controller = new AbortController();
      const request = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return generate(controller.signal);
        })
        .then((result) => {
          if (!controller.signal.aborted) completed.set(key, result);
          while (completed.size > limit) completed.delete(completed.keys().next().value!);
          return result;
        })
        .finally(() => {
          if (active.get(key)?.controller === controller) active.delete(key);
        });
      pending = { request, controller, readers: 0 };
      active.set(key, pending);
    }
    const entry = pending;
    entry.readers++;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const release = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener("abort", abort);
        entry.readers--;
        return true;
      };
      const abort = () => {
        if (!release()) return;
        if (entry.readers === 0) {
          if (active.get(key) === entry) active.delete(key);
          entry.controller.abort();
        }
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      entry.request.then(
        (result) => {
          if (release()) resolve(result);
        },
        (error: unknown) => {
          if (release()) reject(error);
        },
      );
    });
  };
}
