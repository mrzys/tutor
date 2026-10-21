import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { request } from "./bridge";
import { Busy, ErrorBanner } from "./ui";

GlobalWorkerOptions.workerSrc = workerUrl;

export function PdfPreview(props: {
  paperId?: string;
  kind?: string;
  importId?: string;
  reader?: () => Promise<any>;
}) {
  const [retry, setRetry] = createSignal(0);
  const [document, setDocument] = createSignal<PDFDocumentProxy | null>(null);
  const [pages, setPages] = createSignal<number[]>([]);
  const [width, setWidth] = createSignal(700);
  const [loading, setLoading] = createSignal(true);
  const [rendering, setRendering] = createSignal(false);
  const [error, setError] = createSignal("");
  const canvases = new Map<number, HTMLCanvasElement>();
  let container!: HTMLDivElement;
  let loadVersion = 0;
  let renderVersion = 0;
  let renderTasks: RenderTask[] = [];
  function stopRendering() {
    ++renderVersion;
    for (const task of renderTasks) task.cancel();
    renderTasks = [];
    for (const canvas of canvases.values()) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
  onMount(() => {
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver((entries) => {
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          setWidth(
            Math.max(180, Math.floor(entries[0]?.contentRect.width || 700)),
          ),
        120,
      );
    });
    observer.observe(container);
    onCleanup(() => {
      clearTimeout(timer);
      observer.disconnect();
    });
  });
  createEffect(() => {
    const paperId = props.paperId,
      importId = props.importId,
      kind = props.kind;
    const reader = props.reader;
    retry();
    const own = ++loadVersion;
    let task: PDFDocumentLoadingTask | null = null;
    let pdf: PDFDocumentProxy | null = null;
    let closed = false;
    stopRendering();
    setDocument(null);
    setPages([]);
    setError("");
    setLoading(true);
    (async () => {
      const result = reader
        ? await reader()
        : importId
          ? await request("import_original_read", { importId })
          : await request("pdf_read", { paperId, kind });
      if (closed || own !== loadVersion) return;
      if (
        (!reader &&
          (importId
            ? result.importId !== importId
            : result.paperId !== paperId || result.kind !== kind)) ||
        typeof result.dataBase64 !== "string"
      )
        throw new Error("PDF 版本与所选试卷不一致，请重新生成。");
      const raw = atob(result.dataBase64);
      const data = Uint8Array.from(raw, (character) => character.charCodeAt(0));
      // Rust verifies archive ownership/hash. Also detect damaged IPC content before rendering.
      if (result.sha256) {
        const digest = await crypto.subtle.digest("SHA-256", data);
        const actual = Array.from(new Uint8Array(digest), (value) =>
          value.toString(16).padStart(2, "0"),
        ).join("");
        if (actual !== result.sha256)
          throw new Error("PDF 内容校验失败，请重新生成。");
      }
      if (closed || own !== loadVersion) return;
      task = getDocument({ data });
      pdf = await task.promise;
      if (closed || own !== loadVersion) {
        await task.destroy();
        return;
      }
      setPages(Array.from({ length: pdf.numPages }, (_, index) => index + 1));
      setDocument(pdf);
    })()
      .catch((failure: any) => {
        if (!closed && own === loadVersion)
          setError(failure.message || "无法读取 PDF，请重试。");
      })
      .finally(() => {
        if (!closed && own === loadVersion) setLoading(false);
      });
    onCleanup(() => {
      closed = true;
      ++loadVersion;
      stopRendering();
      if (task) void task.destroy().catch(() => {});
      canvases.clear();
    });
  });
  createEffect(() => {
    const pdf = document(),
      available = width();
    if (!pdf) return;
    stopRendering();
    const own = renderVersion;
    let closed = false;
    setRendering(true);
    (async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      for (let number = 1; number <= pdf.numPages; number++) {
        if (closed || own !== renderVersion) return;
        const page = await pdf.getPage(number);
        if (closed || own !== renderVersion) return;
        const canvas = canvases.get(number);
        if (!canvas) continue;
        const natural = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: Math.min(available - 16, 960) / natural.width,
        });
        const density = Math.min(devicePixelRatio || 1, 2);
        canvas.width = Math.ceil(viewport.width * density);
        canvas.height = Math.ceil(viewport.height * density);
        canvas.style.width = `${viewport.width}px`;
        // CSS may clamp width before ResizeObserver redraws. Preserve the page
        // ratio during that interval instead of stretching the old canvas.
        canvas.style.height = "auto";
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法绘制 PDF 页面。");
        const task = page.render({
          canvasContext: context,
          canvas,
          viewport,
          transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0],
        });
        renderTasks.push(task);
        await task.promise;
        if (closed || own !== renderVersion) return;
        page.cleanup();
      }
    })()
      .catch((failure: any) => {
        if (
          !closed &&
          own === renderVersion &&
          failure.name !== "RenderingCancelledException"
        )
          setError(failure.message || "PDF 页面绘制失败。");
      })
      .finally(() => {
        if (!closed && own === renderVersion) setRendering(false);
      });
    onCleanup(() => {
      closed = true;
      stopRendering();
    });
  });
  return (
    <div
      ref={container}
      class="pdf-pages"
      aria-label={
        props.importId
          ? "原卷 PDF 全部页面"
          : `${props.kind === "teacher" ? "教师" : "学生"}卷 PDF 全部页面`
      }
    >
      <ErrorBanner
        message={error()}
        retry={() => setRetry((value) => value + 1)}
      />
      <Show when={loading()}>
        <Busy label="正在读取 PDF…" />
      </Show>
      <Show when={rendering() && !loading()}>
        <p class="muted" role="status">
          正在绘制全部页面…
        </p>
      </Show>
      <For each={pages()}>
        {(number) => (
          <figure class="pdf-page">
            <canvas
              ref={(node) => canvases.set(number, node)}
              aria-label={`PDF 第 ${number} 页`}
            />
            <figcaption>
              第 {number} 页 / {pages().length} 页
            </figcaption>
          </figure>
        )}
      </For>
    </div>
  );
}
