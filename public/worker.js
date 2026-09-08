importScripts('../engine.js');

let cancelled = false;

self.onmessage = (message) => {
  const data = message.data || {};
  if (data.type === 'cancel') {
    // The UI normally terminates the worker because a synchronous DFS cannot
    // receive this message until it yields. Keeping this flag also makes the
    // worker useful to callers that provide an interruptible search later.
    cancelled = true;
    return;
  }
  if (data.type !== 'start') return;

  cancelled = false;
  try {
    const result = ReversiEngine.reconstruct(data.board, {
      positionType: data.positionType || 'terminal',
      maxNodes: data.maxNodes,
      maxMs: data.maxMs,
      unlimited: data.unlimited,
      maxCacheEntries: data.maxCacheEntries,
      cancelled: () => cancelled,
      onProgress: (progress) => self.postMessage({ type: 'progress', ...progress }),
    });
    self.postMessage({ type: 'result', result });
  } catch (error) {
    self.postMessage({
      type: 'result',
      result: { status: 'ERROR', error: error instanceof Error ? error.message : String(error) },
    });
  }
};
