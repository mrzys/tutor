const stageOrder = ['retrieving', 'comparing', 'combining', 'saving'];
const abortError = () => new DOMException('已停止生成', 'AbortError');

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const finish = () => { signal.removeEventListener('abort', stop); resolve(); };
    const timer = setTimeout(finish, ms);
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(abortError()); };
    signal.addEventListener('abort', stop, { once: true });
  });
}

// Smooth only the presentation; network reads and server work keep running.
export function createSelectionProgress({ onProgress, signal, minimumStageMs = 500, now = () => performance.now(), wait = pause }) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  let stage = 'retrieving';
  let shownAt = now();
  let queue = Promise.resolve();
  let failure = null;
  let disposed = false;
  const check = () => { if (disposed || controller.signal.aborted) throw abortError(); };
  async function hold() {
    check();
    if (stage === 'combining' || stage === 'saving') {
      const remaining = minimumStageMs - (now() - shownAt);
      if (remaining > 0) await wait(remaining, controller.signal);
    }
    check();
  }
  async function present(progress) {
    check();
    const next = stageOrder.indexOf(progress.stage);
    if (next < stageOrder.indexOf(stage)) return;
    // JSON responses and very fast streams may omit intermediate events.
    if (next > stageOrder.indexOf('combining') && stageOrder.indexOf(stage) < stageOrder.indexOf('combining')) {
      stage = 'combining'; shownAt = now(); onProgress({ stage });
    }
    if (progress.stage !== stage) {
      await hold(); stage = progress.stage; shownAt = now();
    }
    onProgress(progress);
  }
  function push(progress) {
    if (!stageOrder.includes(progress?.stage) || disposed) return;
    queue = queue.then(() => { if (failure) return; return present(progress); }).catch(error => { failure = error; });
  }
  async function show(progress) { push(progress); await queue; if (failure) throw failure; check(); }
  return {
    push, show,
    async finish() { await show({ stage: 'saving' }); await hold(); },
    dispose() { disposed = true; stop(); signal.removeEventListener('abort', stop); },
  };
}
