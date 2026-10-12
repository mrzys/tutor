import React, { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './PdfPreview.css';

GlobalWorkerOptions.workerSrc = workerUrl;

// Vite emits local font/CMap/image-decoder assets and loads only what this PDF needs.
const binaryUrls = import.meta.glob([
  '../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}',
  '../node_modules/pdfjs-dist/cmaps/*.bcmap',
  '../node_modules/pdfjs-dist/wasm/*.wasm',
], { eager: true, query: '?url', import: 'default' });
const assetFolders = { standardFontDataUrl: 'standard_fonts', cMapUrl: 'cmaps', wasmUrl: 'wasm' };
function localBinaryFactory(signal) {
  return class {
    async fetch({ kind, filename }) {
      const url = binaryUrls[`../node_modules/pdfjs-dist/${assetFolders[kind]}/${filename}`];
      if (!url) throw new Error(`PDF 资源不可用：${filename}`);
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`PDF 资源载入失败：${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    }
  };
}

export default function PdfPreview({ sources, kind, onKindChange, onClose }) {
  const source = sources.find(item => item.kind === kind);
  const [document, setDocument] = useState(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [width, setWidth] = useState(0);
  const pageHost = useRef(null);
  const url = source?.url;

  useEffect(() => {
    const host = pageHost.current;
    const observer = new ResizeObserver(entries => {
      const nextWidth = Math.floor(entries[0].contentRect.width);
      setWidth(current => current === nextWidth ? current : nextWidth);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    setDocument(null); setPageNumber(1); setLoading(true); setError('');
    if (!url) { setLoading(false); setError('此版本尚未生成 PDF，请先生成文件。'); return; }
    const controller = new AbortController();
    const task = getDocument({ url, withCredentials: true, useWorkerFetch: false, BinaryDataFactory: localBinaryFactory(controller.signal) });
    task.promise.then(pdf => {
      if (active) { setDocument(pdf); setLoading(false); }
    }).catch(failure => {
      if (active) { setError(`无法载入 PDF：${failure.message || '请下载文件查看。'}`); setLoading(false); }
    });
    return () => { active = false; controller.abort(); void task.destroy().catch(() => {}); };
  }, [url, retry]);

  useEffect(() => {
    if (!document || width < 1) return;
    let active = true;
    let renderTask;
    let pdfPage;
    // Each render owns its canvas; cancelled renders cannot paint over the next page.
    const canvas = window.document.createElement('canvas');
    const host = pageHost.current;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${source.label}第 ${pageNumber} 页`);
    host.replaceChildren(canvas);
    setRendering(true); setError('');
    const render = async () => {
      try {
        pdfPage = await document.getPage(pageNumber);
        if (!active) { pdfPage.cleanup(); return; }
        const naturalViewport = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: width / naturalViewport.width });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.ceil(viewport.width * ratio);
        canvas.height = Math.ceil(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        renderTask = pdfPage.render({
          canvasContext: canvas.getContext('2d'), viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
          background: '#ffffff',
        });
        await renderTask.promise;
        if (active) setRendering(false);
      } catch (failure) {
        if (active && failure.name !== 'RenderingCancelledException') {
          setRendering(false); setError(`此页预览失败：${failure.message || '请下载文件查看。'}`);
        }
      } finally { pdfPage?.cleanup(); }
    };
    void render();
    return () => { active = false; renderTask?.cancel(); canvas.remove(); };
  }, [document, width, pageNumber, source?.label]);

  const busy = loading || rendering;
  return <section className="pdf-canvas-preview" aria-label="正式试卷 PDF 预览">
    <div className="pdf-canvas-toolbar">
      <div className="pdf-kind-switch" role="group" aria-label="选择试卷版本">{sources.map(item => <button key={item.kind} type="button" aria-pressed={item.kind === kind} onClick={() => onKindChange(item.kind)}>{item.label}</button>)}</div>
      <div className="pdf-page-controls" role="group" aria-label="翻页">
        <button type="button" aria-label="上一页" disabled={!document || pageNumber <= 1} onClick={() => setPageNumber(current => current - 1)}>上一页</button>
        <span aria-live="polite">{document ? `${pageNumber} / ${document.numPages} 页` : '载入页数…'}</span>
        <button type="button" aria-label="下一页" disabled={!document || pageNumber >= document.numPages} onClick={() => setPageNumber(current => current + 1)}>下一页</button>
      </div>
      <div className="pdf-preview-actions">{source?.downloadUrl ? <a href={source.downloadUrl} download>下载 PDF</a> : null}<button type="button" onClick={onClose}>关闭预览</button></div>
    </div>
    <div className="pdf-canvas-stage" aria-busy={busy}>
      {busy ? <p className="pdf-preview-status" role="status">{loading ? '正在载入试卷…' : `正在渲染第 ${pageNumber} 页…`}</p> : null}
      {error ? <div className="pdf-preview-error" role="alert"><p>{error}</p><button type="button" onClick={() => setRetry(current => current + 1)}>重试预览</button>{source?.downloadUrl ? <a href={source.downloadUrl} download>下载文件查看</a> : null}</div> : null}
      <div className="pdf-canvas-page" ref={pageHost}/>
    </div>
    <p className="help">自动适配预览宽度 · 预览与下载为同一 PDF 文件。</p>
  </section>;
}
