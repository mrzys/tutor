import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Columns2, FileText, Image, ZoomIn, ZoomOut } from "lucide-solid";
import { request } from "./bridge";
import { RichText } from "./Paper";
import { Busy, ErrorBanner, Modal } from "./ui";
import "./SourceCompare.css";

GlobalWorkerOptions.workerSrc = workerUrl;
type CompareMode = "split" | "image" | "text";

export function SourceCompare(props: {
  importId: string;
  pages?: number[];
  extractedPages?: string[];
  question?: any;
  onClose: () => void;
}) {
  const [page, setPage] = createSignal(props.pages?.find(value => value > 0) || 1);
  const [mode, setMode] = createSignal<CompareMode>("split");
  const [zoom, setZoom] = createSignal(1);
  const [source, setSource] = createSignal<any>(null);
  const [loading, setLoading] = createSignal(false);
  const [rendering, setRendering] = createSignal(false);
  const [error, setError] = createSignal("");
  const [retry, setRetry] = createSignal(0);
  const [width, setWidth] = createSignal(600);
  let imagePane!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  let loadVersion = 0;
  let renderVersion = 0;
  let closed = false;
  let pdfTask: PDFDocumentLoadingTask | null = null;
  let pdfPromise: Promise<PDFDocumentProxy> | null = null;
  let renderTask: RenderTask | null = null;
  const modes = [
    { id: "split" as const, label: "并排对照", icon: Columns2 },
    { id: "image" as const, label: "原图", icon: Image },
    { id: "text" as const, label: "识别原文", icon: FileText },
  ];
  const pageCount = createMemo(() => source()?.pageCount || props.extractedPages?.length || Math.max(1, ...(props.pages || [])));
  const sourceText = () => source()?.text || props.extractedPages?.[page() - 1] || "";
  async function verifiedBytes(value: any): Promise<Uint8Array> {
    if (typeof value?.dataBase64 !== "string" || !/^[a-f0-9]{64}$/i.test(value.sha256 || ""))
      throw new Error("原件数据或校验信息不完整，请重新打开。");
    const bytes = Uint8Array.from(atob(value.dataBase64), char => char.charCodeAt(0));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== value.sha256) throw new Error("原件内容校验失败，请保留原件重新导入。");
    return bytes;
  }
  function stopRender() {
    renderVersion++;
    renderTask?.cancel();
    renderTask = null;
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
  async function originalPdf() {
    if (!pdfPromise) {
      pdfPromise = (async () => {
        const value = await request("import_original_read", { importId: props.importId });
        if (value.importId !== props.importId) throw new Error("原卷与当前导入记录不一致。");
        const bytes = await verifiedBytes(value);
        if (closed) throw new Error("已关闭原卷对照。");
        pdfTask = getDocument({ data: bytes });
        return pdfTask.promise;
      })().catch(failure => { pdfPromise = null; throw failure; });
    }
    return pdfPromise;
  }
  createEffect(() => {
    const number = page(); retry();
    const own = ++loadVersion;
    stopRender(); setSource(null); setError(""); setLoading(true);
    (async () => {
      const value = await request("import_source_page", { importId: props.importId, page: number });
      if (closed || own !== loadVersion) return;
      if (value.importId !== props.importId || value.page !== number) throw new Error("原页与当前选择不一致，请重试。");
      if (value.image) {
        if (value.image.mimeType !== "image/png") throw new Error("原页图像格式不受支持。");
        await verifiedBytes(value.image);
      }
      if (closed || own !== loadVersion) return;
      setSource(value);
    })().catch(failure => { if (!closed && own === loadVersion) setError(failure.message || "无法读取原卷材料。"); })
      .finally(() => { if (!closed && own === loadVersion) setLoading(false); });
  });
  createEffect(() => {
    const value = source(), number = page(), available = width(), scale = zoom(), view = mode();
    stopRender();
    if (!value || value.image || !value.hasPdf || view === "text") { setRendering(false); return; }
    const own = renderVersion;
    setRendering(true);
    (async () => {
      const pdf = await originalPdf();
      if (closed || own !== renderVersion) return;
      const pdfPage = await pdf.getPage(number);
      if (closed || own !== renderVersion) return;
      const natural = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: Math.max(120, available - 24) / natural.width * scale });
      const density = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.ceil(viewport.width * density);
      canvas.height = Math.ceil(viewport.height * density);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法显示原卷页面。");
      renderTask = pdfPage.render({ canvas, canvasContext: context, viewport, transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0] });
      await renderTask.promise;
      if (!closed && own === renderVersion) pdfPage.cleanup();
    })().catch(failure => {
      if (!closed && own === renderVersion && failure.name !== "RenderingCancelledException") setError(failure.message || "原卷页面显示失败。");
    }).finally(() => { if (!closed && own === renderVersion) setRendering(false); });
  });
  onMount(() => {
    const observer = new ResizeObserver(entries => {
      const value = entries[0]?.contentRect.width;
      if (value && Math.round(value) !== width()) setWidth(Math.round(value));
    });
    observer.observe(imagePane);
    onCleanup(() => observer.disconnect());
  });
  onCleanup(() => { closed = true; loadVersion++; stopRender(); void pdfTask?.destroy().catch(() => {}); });
  function tabKey(event: KeyboardEvent, index: number) {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? modes.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + modes.length) % modes.length;
    setMode(modes[next].id);
    (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  }
  return (
    <Modal title="原文与原图对照" wide expanded stable onClose={props.onClose}>
      <div class="source-compare">
        <div class="source-compare-toolbar">
          <label class="source-compare-page">原卷页码
            <select aria-label="原卷页码" value={page()} onChange={event => { setPage(Number(event.currentTarget.value)); setZoom(1); }}>
              <For each={Array.from({ length: pageCount() }, (_, index) => index + 1)}>{number => <option value={number}>第 {number} 页{props.pages?.includes(number) ? " · 本题" : ""}</option>}</For>
            </select>
          </label>
          <div class="source-compare-tabs" role="tablist" aria-label="原卷对照方式">
            <For each={modes}>{(item, index) => <button type="button" role="tab" aria-selected={mode() === item.id} tabIndex={mode() === item.id ? 0 : -1} onKeyDown={event => tabKey(event, index())} onClick={() => setMode(item.id)}><item.icon size={16}/>{item.label}</button>}</For>
          </div>
          <div class="source-compare-zoom" aria-label="原图缩放">
            <button type="button" title="缩小原图" aria-label="缩小原图" disabled={zoom() <= 1 || mode() === "text"} onClick={() => setZoom(value => Math.max(1, value - .25))}><ZoomOut size={17}/></button>
            <button type="button" disabled={mode() === "text"} title="恢复适合宽度" onClick={() => setZoom(1)}>{Math.round(zoom() * 100)}%</button>
            <button type="button" title="放大原图" aria-label="放大原图" disabled={zoom() >= 3 || mode() === "text"} onClick={() => setZoom(value => Math.min(3, value + .25))}><ZoomIn size={17}/></button>
          </div>
        </div>
        <p class="source-compare-note">原图保留原卷版面；识别原文是 OCR 提取结果。请以原图核对公式、图表和遗漏。</p>
        <ErrorBanner message={error()} retry={() => setRetry(value => value + 1)}/>
        <Show when={loading()}><Busy label="正在读取已保存的原卷…"/></Show>
        <div class={`source-compare-panes source-compare-${mode()}`}>
          <section class="source-compare-panel source-compare-image-panel" hidden={mode() === "text"} aria-label="原卷原图">
            <h3>原图 · 第 {page()} 页</h3>
            <div class="source-compare-image-scroll" ref={imagePane}>
              <Show when={rendering()}><p class="muted" role="status">正在显示原卷页面…</p></Show>
              <Show when={source()?.image}><img class="source-compare-original-image" src={`data:image/png;base64,${source()?.image?.dataBase64}`} alt={`原卷第 ${page()} 页全页原图`} style={{ width: `${zoom() * 100}%` }} onError={() => setError("已保存的原页图像无法显示，请查看原卷 PDF。")} /></Show>
              <canvas class="source-compare-canvas" ref={canvas} hidden={Boolean(source()?.image) || !source()?.hasPdf} aria-label={`原卷 PDF 第 ${page()} 页`}/>
              <Show when={source() && !source().image && !source().hasPdf}><p class="warning-text">此记录未保存原页图像或 PDF，无法显示原图。已有识别原文仍保留。</p></Show>
            </div>
          </section>
          <section class="source-compare-panel source-compare-text-panel" hidden={mode() === "image"} aria-label="OCR 识别原文">
            <h3>识别原文 · 第 {page()} 页</h3>
            <div class="source-compare-text-scroll paper-rich-text"><Show when={sourceText()} fallback={<p class="muted">此页未保存识别原文，请查看原图。</p>}><RichText text={sourceText()} question={props.question} teacher/></Show></div>
          </section>
        </div>
      </div>
    </Modal>
  );
}
