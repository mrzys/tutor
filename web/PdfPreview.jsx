import React, { useEffect, useRef, useState } from 'react';
import { CloseButton } from './CloseButton.jsx';
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
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(null);
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
    setDocument(null); setProgress(null); setLoading(true); setError('');
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
    const host = pageHost.current;
    host.replaceChildren();
    if (!document || width < 1) return;
    let active = true;
    let renderTask;
    const canvases = [];
    setProgress({ completed: 0, total: document.numPages }); setError('');
    const render = async () => {
      const failedPages = [];
      // Render in order, one task at a time. Each pass owns its canvases so a
      // cancelled version or resize cannot paint over the current document.
      for (let pageNumber = 1; pageNumber <= document.numPages && active; pageNumber++) {
        let pdfPage;
        const figure = window.document.createElement('figure');
        figure.className = 'pdf-canvas-page';
        const caption = window.document.createElement('figcaption');
        caption.textContent = `第 ${pageNumber} 页 / 共 ${document.numPages} 页`;
        const canvas = window.document.createElement('canvas');
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `${source?.label || '试卷'}第 ${pageNumber} 页`);
        figure.append(canvas, caption);
        host.append(figure);
        canvases.push(canvas);
        try {
          pdfPage = await document.getPage(pageNumber);
          if (!active) break;
          const naturalViewport = pdfPage.getViewport({ scale: 1 });
          const viewport = pdfPage.getViewport({ scale: width / naturalViewport.width });
          // Bound both a page's backing store and the whole document, including
          // high-DPI screens. CSS size still follows the original dimensions.
          const pixelBudget = Math.min(3_000_000, 24_000_000 / document.numPages);
          const ratio = Math.min(window.devicePixelRatio || 1, 2,
            Math.sqrt(pixelBudget / (viewport.width * viewport.height)));
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
        } catch (failure) {
          if (active && failure.name !== 'RenderingCancelledException') {
            failedPages.push(pageNumber);
            canvas.remove();
            const message = window.document.createElement('p');
            message.className = 'pdf-page-error';
            message.textContent = `第 ${pageNumber} 页预览失败，请重试或下载查看。`;
            figure.prepend(message);
          }
        } finally { pdfPage?.cleanup(); renderTask = null; }
        if (active) setProgress({ completed: pageNumber, total: document.numPages });
      }
      if (active) {
        setProgress(null);
        if (failedPages.length) {
          setError(`第 ${failedPages.join('、')} 页预览失败，请重试或下载文件查看。`);
        }
      }
    };
    void render();
    return () => {
      active = false; renderTask?.cancel(); host.replaceChildren();
      // Release old backing stores promptly on version changes and resizing.
      for (const canvas of canvases) { canvas.width = 0; canvas.height = 0; }
    };
  }, [document, width, source?.label]);

  const busy = loading || !!progress;
  return <section className="pdf-canvas-preview" aria-label="正式试卷 PDF 预览">
    <div className="pdf-canvas-toolbar">
      <div className="pdf-kind-switch" role="group" aria-label="选择试卷版本">{sources.map(item => <button key={item.kind} type="button" aria-pressed={item.kind === kind} onClick={() => onKindChange(item.kind)}>{item.label}</button>)}</div>
      <div className="pdf-page-controls">
        <span aria-live="polite">{document ? `全卷预览 · 共 ${document.numPages} 页` : '载入页数…'}</span>
      </div>
      <div className="pdf-preview-actions">{source?.downloadUrl ? <a href={source.downloadUrl} download>下载 PDF</a> : null}<CloseButton label="关闭预览" onClick={onClose}/></div>
    </div>
    <div className="pdf-canvas-stage" aria-busy={busy}>
      {busy ? <p className="pdf-preview-status" role="status">{loading ? '正在载入试卷…' : `正在载入页面 ${progress.completed} / ${progress.total}…`}</p> : null}
      {error ? <div className="pdf-preview-error" role="alert"><p>{error}</p><button type="button" onClick={() => setRetry(current => current + 1)}>重试预览</button>{source?.downloadUrl ? <a href={source.downloadUrl} download>下载文件查看</a> : null}</div> : null}
      <div className="pdf-canvas-pages" ref={pageHost}/>
    </div>
    <p className="help">自动适配预览宽度 · 预览与下载为同一 PDF 文件。</p>
  </section>;
}
