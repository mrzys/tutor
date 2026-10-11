export function createMemoryIntakeStorage() {
  const sessions = new Map();
  const queues = new Map();
  return {
    async get(id) { return structuredClone(sessions.get(id) ?? null); },
    async put(session) { sessions.set(session.sessionId, structuredClone(session)); },
    async transaction(id, callback) {
      const previous = queues.get(id) ?? Promise.resolve();
      let release;
      const current = new Promise(resolve => { release = resolve; });
      queues.set(id, current);
      await previous;
      try { return await callback(); }
      finally { release(); if (queues.get(id) === current) queues.delete(id); }
    },
  };
}
