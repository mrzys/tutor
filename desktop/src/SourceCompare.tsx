import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Columns2, FileText, Image, ZoomIn, ZoomOut, LocateFixed, Maximize2 } from "lucide-solid";
import { request } from "./bridge";
import { RichText } from "./Paper";
import { Busy, ErrorBanner, Modal } from "./ui";
import "./SourceCompare.css";
import { sourcePageFocus } from "./source-page-focus";

GlobalWorkerOptions.workerSrc = workerUrl;
type CompareMode = "split" | "image" | "text";

export type SourcePageViewerProps = {
  importId: string;
  pages?: number[];
  question?: any;
  focusRequest?: number;
  onOpenPdf?: () => void;
};

export type SourceCompareProps = {
  importId: string;
  pages?: number[];
  extractedPages?: string[];
  question?: any;
  initialPage?: number;
  onOpenPdf?: () => void;
  onClose: () => void;
};

async function verifiedSourceBytes(value: any): Promise<Uint8Array> {
  if (typeof value?.dataBase64 !== "string" || !/^[a-f0-9]{64}$/i.test(value.sha256 || "")) throw new Error("原件数据或校验信息不完整，请重新打开。");
  const bytes = Uint8Array.from(atob(value.dataBase64), char => char.charCodeAt(0));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== value.sha256) throw new Error("原件内容校验失败，请保留原件重新导入。");
  return bytes;
}

/** Review-only original page. The host places the actual transcribed question
 * beside this viewer; source pages never become student question assets. */
export function SourcePageViewer(props: SourcePageViewerProps) {
  const [page, setPage] = createSignal(props.pages?.find(number => number > 0) || 1);
  // Scanned multi-column pages remain readable before any validated question
  // location is available. This magnifies the complete page; it is not a crop
  // or an inferred location, and the fit-width control still returns to 100%.
  const initialZoom = 2;
  const [zoom, setZoom] = createSignal(initialZoom), [width, setWidth] = createSignal(500);
  const [source, setSource] = createSignal<any>(null), [loading, setLoading] = createSignal(false);
  const [rendering, setRendering] = createSignal(false), [imageReady, setImageReady] = createSignal(false);
  const [error, setError] = createSignal(""), [retry, setRetry] = createSignal(0), [focusTick, setFocusTick] = createSignal(0);
  const [expanded, setExpanded] = createSignal(false);
  let pane!: HTMLDivElement, stage!: HTMLDivElement, canvas!: HTMLCanvasElement;
  let closed = false, loadVersion = 0, renderVersion = 0, pdfVersion = 0, identity = "", pdfOwner = "", autoFocusIdentity = "";
  let pdfTask: PDFDocumentLoadingTask | null = null, pdfPromise: Promise<PDFDocumentProxy> | null = null, renderTask: RenderTask | null = null;
  let drag: { pointer: number; x: number; y: number; left: number; top: number } | null = null;
  const cache = new Map<string, any>();
  const focus = createMemo(() => sourcePageFocus(source(), String(props.question?.questionId || "")));
  const pages = createMemo(() => [...new Set((props.pages || []).filter(number => Number.isSafeInteger(number) && number > 0))]);
  const pageCount = () => source()?.pageCount || Math.max(1, ...pages());
  function stopRender() { renderVersion++; renderTask?.cancel(); renderTask = null; if (canvas) { canvas.width = 0; canvas.height = 0; } }
  function resetPdf() { stopRender(); pdfVersion++; void pdfTask?.destroy().catch(() => {}); pdfTask = null; pdfPromise = null; pdfOwner = ""; }
  createEffect(() => {
    const next = `${props.importId}|${props.question?.questionId || ""}`;
    if (next === identity) return;
    if (identity.split("|")[0] !== props.importId) { resetPdf(); cache.clear(); }
    identity = next; setExpanded(false); setPage(pages()[0] || 1); setZoom(initialZoom); setFocusTick(value => value + 1);
  });
  createEffect(() => {
    const importId = props.importId, questionId = String(props.question?.questionId || ""), number = page(); retry();
    const own = ++loadVersion, key = `${importId}|${questionId}|${number}`;
    stopRender(); setSource(null); setImageReady(false); setError(""); setLoading(true);
    (async () => {
      let value = cache.get(key);
      if (!value) {
        value = await request("import_source_page", { importId, page: number, ...(questionId ? { questionId } : {}) });
        if (value.importId !== importId || value.page !== number || (questionId && value.questionId !== questionId)) throw new Error("原页与当前题目不一致，请重试。");
        if (value.image) { if (value.image.mimeType !== "image/png") throw new Error("原页图像格式不受支持。"); await verifiedSourceBytes(value.image); }
        if (closed || own !== loadVersion) return;
        cache.set(key, value); if (cache.size > 3) cache.delete(cache.keys().next().value!);
      }
      if (!closed && own === loadVersion) { setSource(value); setFocusTick(tick => tick + 1); }
    })().catch(failure => { if (!closed && own === loadVersion) setError(failure.message || "无法读取原卷材料。"); })
      .finally(() => { if (!closed && own === loadVersion) setLoading(false); });
  });
  async function originalPdf(importId: string) {
    if (!pdfPromise || pdfOwner !== importId) {
      void pdfTask?.destroy().catch(() => {}); pdfTask = null; pdfPromise = null; pdfOwner = importId;
      const own = ++pdfVersion;
      pdfPromise = (async () => {
        const value = await request("import_original_read", { importId });
        if (value.importId !== importId) throw new Error("原卷与当前导入记录不一致。");
        const bytes = await verifiedSourceBytes(value);
        if (closed || own !== pdfVersion || pdfOwner !== importId || props.importId !== importId) throw new Error("原卷已切换。");
        pdfTask = getDocument({ data: bytes }); return pdfTask.promise;
      })().catch(failure => { if (own === pdfVersion && pdfOwner === importId) pdfPromise = null; throw failure; });
    }
    return pdfPromise;
  }
  createEffect(() => {
    const value = source(), available = width(), scale = zoom(), importId = props.importId;
    stopRender(); setRendering(false);
    if (!value || value.image || !value.hasPdf) return;
    const number = value.page, own = renderVersion; setRendering(true);
    (async () => {
      const pdf = await originalPdf(importId); if (closed || own !== renderVersion) return;
      const pdfPage = await pdf.getPage(number); if (closed || own !== renderVersion) return;
      const natural = pdfPage.getViewport({ scale: 1 }), viewport = pdfPage.getViewport({ scale: Math.max(120, available - 24) / natural.width * scale });
      const density = Math.min(devicePixelRatio || 1, 2); canvas.width = Math.ceil(viewport.width * density); canvas.height = Math.ceil(viewport.height * density);
      canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
      const context = canvas.getContext("2d"); if (!context) throw new Error("无法显示原卷页面。");
      renderTask = pdfPage.render({ canvas, canvasContext: context, viewport, transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0] });
      await renderTask.promise; if (!closed && own === renderVersion) pdfPage.cleanup();
    })().catch(failure => { if (!closed && own === renderVersion && failure.name !== "RenderingCancelledException") setError(failure.message || "原卷页面显示失败。"); })
      .finally(() => { if (!closed && own === renderVersion) setRendering(false); });
  });
  function locate() {
    if (!pane || !stage) return; const bounds = focus()?.bounds;
    pane.scrollTo({ left: bounds ? Math.max(0, stage.offsetLeft + stage.clientWidth * bounds.left / 100 - 16) : 0,
      top: bounds ? Math.max(0, stage.offsetTop + stage.clientHeight * bounds.top / 100 - 24) : 0, behavior: "instant" });
  }
  createEffect(() => {
    focusTick(); props.focusRequest; zoom(); width(); if (!imageReady()) return;
    const current = focus(); if (!current) return;
    const key = `${identity}|${page()}|${source()?.image?.sha256}`;
    if (key !== autoFocusIdentity) {
      autoFocusIdentity = key;
      // Fit only a validated question range on first display. Subsequent user
      // zoom choices are retained until switching question or page.
      setZoom(Math.max(1, Math.min(2.5, Math.round(90 / current.bounds.width * 4) / 4)));
    }
    requestAnimationFrame(() => { if (!closed) locate(); });
  });
  onMount(() => { const observer = new ResizeObserver(entries => { const next = entries[0]?.contentRect.width; if (next && Math.round(next) !== width()) setWidth(Math.round(next)); }); observer.observe(pane); onCleanup(() => observer.disconnect()); });
  onCleanup(() => { closed = true; loadVersion++; resetPdf(); cache.clear(); });
  function beginDrag(event: PointerEvent) { if (event.button !== 0 || event.pointerType === "touch" || (event.target as HTMLElement).closest("button,a,input,select,textarea")) return; drag = { pointer:event.pointerId, x:event.clientX, y:event.clientY, left:pane.scrollLeft, top:pane.scrollTop }; pane.setPointerCapture(event.pointerId); pane.classList.add("is-dragging"); event.preventDefault(); }
  function endDrag() { drag = null; pane.classList.remove("is-dragging"); }
  return <><section class="source-page-viewer" aria-label="本题原卷">
    <div class="source-page-toolbar">
      <label>原卷<select aria-label="本题原卷页码" value={page()} onChange={event => { setPage(Number(event.currentTarget.value)); setZoom(initialZoom); }}><For each={pages().length ? pages() : Array.from({ length:pageCount() }, (_,index)=>index+1)}>{number=><option value={number}>第 {number} 页{pages().includes(number) ? " · 本题" : ""}</option>}</For></select></label>
      <div class="source-page-document-actions">
        <button type="button" class="text-button" onClick={()=>setExpanded(true)}><Maximize2 size={16}/>展开对照</button>
        <Show when={props.onOpenPdf}><button type="button" class="text-button" onClick={()=>props.onOpenPdf?.()}><FileText size={16}/>整份 PDF</button></Show>
      </div>
      <div class="source-page-controls" role="group" aria-label="原页缩放与定位">
        <button type="button" aria-label="缩小原图" title="缩小原图" disabled={zoom() <= 1} onClick={()=>setZoom(v=>Math.max(1,v-.25))}><ZoomOut size={16}/></button>
        <button type="button" title="恢复适合宽度" aria-label="恢复适合宽度" onClick={()=>setZoom(1)}>{Math.round(zoom()*100)}%</button>
        <button type="button" aria-label="放大原图" title="放大原图" disabled={zoom() >= 3} onClick={()=>setZoom(v=>Math.min(3,v+.25))}><ZoomIn size={16}/></button>
        <button type="button" class="source-page-locate" aria-label="定位当前题原图" title={!focus() ? "缺少可靠的本题坐标，显示整页原图" : "定位当前题在原卷中的位置"} disabled={!focus() || !imageReady()} onClick={locate}><LocateFixed size={16}/>定位本题</button>
      </div>
    </div>
    <div class="source-page-image-scroll" ref={pane} tabIndex={0} aria-label="原图，可滚动或拖动浏览" onPointerDown={beginDrag} onPointerMove={event=>{ if (drag?.pointer===event.pointerId) { pane.scrollLeft=drag.left+drag.x-event.clientX; pane.scrollTop=drag.top+drag.y-event.clientY; } }} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
      <Show when={loading()}><Busy label="正在读取已保存的原卷…"/></Show><ErrorBanner message={error()} retry={()=>{cache.clear();setRetry(v=>v+1);}}/>
      <Show when={rendering()}><p class="muted" role="status">正在显示原卷页面…</p></Show>
      <div class="source-page-image-stage" ref={stage} style={{width:`${zoom()*100}%`}}>
        <Show when={source()?.image}><img class="source-page-original" draggable={false} src={`data:image/png;base64,${source()?.image.dataBase64}`} alt={`原卷第 ${page()} 页`} onLoad={event=>{ const value=source()?.image; if (value?.width && (event.currentTarget.naturalWidth!==value.width || event.currentTarget.naturalHeight!==value.height)) {setError("原页图像尺寸与已保存材料不一致，未定位题目。");setImageReady(false);return;}setImageReady(true); }} onError={()=>{setImageReady(false);setError("已保存的原页图像无法显示，请查看原卷 PDF。");}}/></Show>
        <canvas class="source-page-canvas" ref={canvas} hidden={Boolean(source()?.image) || !source()?.hasPdf} aria-label={`原卷 PDF 第 ${page()} 页`}/>
        <Show when={imageReady()}><For each={focus()?.boxes || []}>{box=><span class="source-page-focus" aria-hidden="true" style={{left:`${box.left}%`,top:`${box.top}%`,width:`${box.width}%`,height:`${box.height}%`}}/>}</For></Show>
      </div>
      <Show when={source() && !source().image && !source().hasPdf}><p class="warning-text">此记录未保存原页图像或 PDF，无法显示原图。</p></Show>
    </div>
  </section>
    <Show when={expanded()}><SourceCompare importId={props.importId} pages={props.pages} question={props.question} initialPage={page()}
      onClose={()=>setExpanded(false)} onOpenPdf={props.onOpenPdf}/></Show>
  </>;
}

export function SourceCompare(props: SourceCompareProps) {
  const firstPage = () => Number.isSafeInteger(props.initialPage) && props.initialPage! > 0 ? props.initialPage! : props.pages?.find(value => value > 0) || 1;
  const [page, setPage] = createSignal(firstPage());
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
  let pdfVersion = 0, pdfOwner = "", importIdentity = "";
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
  function stopRender() {
    renderVersion++;
    renderTask?.cancel();
    renderTask = null;
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
  function resetPdf() { stopRender(); pdfVersion++; void pdfTask?.destroy().catch(() => {}); pdfTask = null; pdfPromise = null; pdfOwner = ""; }
  createEffect(() => {
    if (importIdentity === props.importId) return;
    importIdentity = props.importId;
    resetPdf(); setPage(firstPage()); setZoom(1);
  });
  async function originalPdf(importId: string) {
    if (!pdfPromise || pdfOwner !== importId) {
      void pdfTask?.destroy().catch(() => {}); pdfTask = null; pdfPromise = null; pdfOwner = importId;
      const own = ++pdfVersion;
      pdfPromise = (async () => {
        const value = await request("import_original_read", { importId });
        if (value.importId !== importId) throw new Error("原卷与当前导入记录不一致。");
        const bytes = await verifiedSourceBytes(value);
        if (closed || own !== pdfVersion || pdfOwner !== importId || props.importId !== importId) throw new Error("原卷已切换。");
        pdfTask = getDocument({ data: bytes });
        return pdfTask.promise;
      })().catch(failure => { if (own === pdfVersion && pdfOwner === importId) pdfPromise = null; throw failure; });
    }
    return pdfPromise;
  }
  createEffect(() => {
    const number = page(), importId = props.importId; retry();
    const own = ++loadVersion;
    stopRender(); setSource(null); setError(""); setLoading(true);
    (async () => {
      const value = await request("import_source_page", { importId, page: number, includeTextAssets: true });
      if (closed || own !== loadVersion) return;
      if (value.importId !== importId || value.page !== number) throw new Error("原页与当前选择不一致，请重试。");
      if (value.image) {
        if (value.image.mimeType !== "image/png") throw new Error("原页图像格式不受支持。");
        await verifiedSourceBytes(value.image);
      }
      if (closed || own !== loadVersion) return;
      setSource(value);
    })().catch(failure => { if (!closed && own === loadVersion) setError(failure.message || "无法读取原卷材料。"); })
      .finally(() => { if (!closed && own === loadVersion) setLoading(false); });
  });
  createEffect(() => {
    const value = source(), number = page(), available = width(), scale = zoom(), view = mode(), importId = props.importId;
    stopRender();
    if (!value || value.image || !value.hasPdf || view === "text") { setRendering(false); return; }
    const own = renderVersion;
    setRendering(true);
    (async () => {
      const pdf = await originalPdf(importId);
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
  onCleanup(() => { closed = true; loadVersion++; resetPdf(); });
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
          <Show when={props.onOpenPdf}><button type="button" class="text-button source-compare-open-pdf" onClick={()=>{props.onClose();props.onOpenPdf?.();}}><FileText size={16}/>整份 PDF</button></Show>
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
            <div class="source-compare-text-scroll paper-rich-text"><Show when={sourceText()} fallback={<p class="muted">此页未保存识别原文，请查看原图。</p>}><RichText text={sourceText()} question={source()?.context ?? props.question} teacher/></Show></div>
          </section>
        </div>
      </div>
    </Modal>
  );
}
