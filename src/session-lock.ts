const sessionQueues = new Map<string, Promise<void>>();

/** Serialize writes for one Session without blocking the Node.js event loop. */
export async function withSessionLock<T>(
  workspacePath: string,
  sessionId: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const key = `${workspacePath}\0${sessionId}`;
  const previous = sessionQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  sessionQueues.set(key, queued);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (sessionQueues.get(key) === queued) sessionQueues.delete(key);
  }
}
