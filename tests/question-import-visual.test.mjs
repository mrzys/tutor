import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { createQuestionImportService, extractQuestionDocument } from '../src/question-bank/imports.mjs';

const exec = promisify(execFile);
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tutor-visual-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function python() {
  if (process.env.TUTOR_PYTHON) return process.env.TUTOR_PYTHON;
  const bundled = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python');
  try { await access(bundled); return bundled; } catch { return process.platform === 'win32' ? 'python' : 'python3'; }
}
async function fixture(directory, source) {
  await exec(await python(), ['-c', source, directory], {
    windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
}

test('DOCX preserves paragraph/table order, cells and equation glyphs while exposing missing image input', async t => {
  const directory = await temporary(t);
  await fixture(directory, String.raw`
import pathlib,sys,zipfile
out=pathlib.Path(sys.argv[1])/'source.docx'
xml='''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>
<w:p><w:r><w:t>Before table</w:t></w:r><m:oMath><m:r><m:t>x=1</m:t></m:r></m:oMath></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Count</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>3 &amp; 4</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>8</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>After table</w:t><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p>
<w:sectPr/></w:body></w:document>'''
rels='''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="media/figure.png" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/></Relationships>'''
with zipfile.ZipFile(out,'w') as z:
 z.writestr('word/document.xml',xml)
 z.writestr('word/_rels/document.xml.rels',rels)
 z.writestr('word/media/figure.png',b'fixture-image')
`);
  const result = await extractQuestionDocument(path.join(directory, 'source.docx'));
  const page = result.pages[0];
  assert.equal(result.pageCount, 1);
  assert.match(page.text, /Before tablex=1/);
  assert.ok(page.text.indexOf('Before table') < page.text.indexOf('<table'));
  assert.ok(page.text.indexOf('</table>') < page.text.indexOf('After table'));
  assert.match(page.text, /<td>3 &amp; 4<\/td><td>8<\/td>/);
  assert.deepEqual(page.tables[0].rows, [['Value', 'Count'], ['3 & 4', '8']]);
  assert.equal(page.tables[0].rowCount, 2);
  assert.equal(page.tables[0].columnCount, 2);
  assert.equal(page.tables[0].requiresReview, true);
  assert.equal(page.visuals[0].relationshipId, 'rId1');
  assert.equal(page.visuals[0].target, 'media/figure.png');
  assert.equal(page.visuals[0].pixelsProvidedToModel, false);
  assert.match(page.text, /SOURCE_VISUAL_UNRESOLVED/);
});

test('PDF retains ruled table rows and identifies raster/vector content without flagging a clean following page', async t => {
  const directory = await temporary(t);
  await fixture(directory, String.raw`
import pathlib,sys,io
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.platypus import Table,TableStyle
from PIL import Image
out=pathlib.Path(sys.argv[1])/'source.pdf'
c=canvas.Canvas(str(out))
c.drawString(60,780,'Question with figure and table')
png=io.BytesIO();Image.new('RGB',(8,8),(0,0,0)).save(png,format='PNG');png.seek(0)
c.drawImage(ImageReader(png),60,680,width=40,height=40)
table=Table([['Value','Count'],['3','8']],colWidths=[80,80],rowHeights=[25,25])
table.setStyle(TableStyle([('GRID',(0,0),(-1,-1),1,'black')]))
table.wrapOn(c,300,300);table.drawOn(c,60,600)
c.showPage();c.drawString(60,780,'Clean textual question');c.save()
`);
  const result = await extractQuestionDocument(path.join(directory, 'source.pdf'));
  assert.equal(result.pageCount, 2);
  const page = result.pages[0];
  assert.ok(page.visuals.some(item => item.kind === 'image' && item.width === 8));
  assert.ok(page.visuals.some(item => item.kind === 'vector_drawing'));
  assert.deepEqual(page.tables[0].rows, [['Value', 'Count'], ['3', '8']]);
  assert.match(page.text, /<td>Value<\/td><td>Count<\/td>/);
  assert.match(page.text, /SOURCE_VISUAL_UNRESOLVED/);
  assert.deepEqual(result.pages[1].visuals, []);
  assert.deepEqual(result.pages[1].tables, []);
});

test('Markdown image/table references require review but text-only mathematical expressions remain unaffected', async t => {
  const directory = await temporary(t);
  const filename = path.join(directory, 'source.md');
  await writeFile(filename, '如图，读取频数。 ![图](figure.png)\n\n| 值 | 数量 |\n| --- | --- |\n| 3 | 8 |');
  const graphic = await extractQuestionDocument(filename);
  assert.equal(graphic.pages[0].visuals.length, 1);
  assert.equal(graphic.pages[0].tables.length, 1);
  await writeFile(filename, '已知函数 $f(x)=x^2$，求值。可将函数图像平移。在数轴上表示区间。答案：1。\n集合 A={x | x<1}。\n\n---\n\n集合 B={x | x>0}。');
  const clean = await extractQuestionDocument(filename);
  assert.deepEqual(clean.pages[0].visuals, []);
  assert.deepEqual(clean.pages[0].tables, []);
});

const question = {
  sourceLabel: 'Q1', pages: [1], questionType: 'fill_blank',
  student: { stem: 'LLM omitted the visual marker', options: [], parts: [] },
  teacher: { answers: [{ partId: 'main', text: '8', sourceBasis: 'explicit' }], solutions: [{ partId: 'main', text: 'Count the entries.', sourceBasis: 'explicit' }] },
  dimensions: { chapterCandidates: [], taskCandidates: [], primaryTopics: [], requiredKnowledge: [], knowledgePoints: [], allowedSolution: '', cognition: 'apply', abilities: [], literacies: [], difficultySuggestion: { level: 'unknown', rationale: '' } },
};

test('server source metadata forces related staged questions to review even when LLM omits images and tables', async t => {
  const directory = await temporary(t);
  const visual = { id: 'figure-1', page: 1, kind: 'image', requiresReview: true, pixelsProvidedToModel: false };
  const table = { id: 'table-1', page: 1, rows: [['3', '8']], rowCount: 1, columnCount: 2, requiresReview: true };
  const service = createQuestionImportService({ storeRoot: path.join(directory, 'imports'),
    extractor: async () => ({ pageCount: 2, totalCharacters: 40, pages: [
      { page: 1, text: '[SOURCE_VISUAL_UNRESOLVED figure-1] table', visuals: [visual], tables: [table] },
      { page: 2, text: 'Clean textual question', visuals: [], tables: [] },
    ] }), gateway: { publicStatus: () => ({ configured: true }), async propose(context) {
      assert.deepEqual(context.source.visuals, [visual]);
      assert.deepEqual(context.source.tables, [table]);
      assert.match(context.source.visualInput, /pixels are not provided/);
      return { ok: true, proposal: { title: 'Fixture', questions: [structuredClone(question), { ...structuredClone(question), pages: [2] }, { ...structuredClone(question), pages: [3] }] }, run: { status: 'succeeded' } };
    } },
  });
  const request = Readable.from([Buffer.from(JSON.stringify({ filename: 'source.txt', mimeType: 'text/plain', text: 'Source' }))]);
  request.headers = { 'content-type': 'application/json' };
  const result = await service.create(request);
  assert.equal(result.ok, true);
  assert.deepEqual(result.import.source.visuals, [visual]);
  assert.deepEqual(result.import.source.tables, [table]);
  const codes = result.import.questions.map(item => item.reviewIssues.map(issue => issue.code));
  assert.ok(codes[0].includes('source_visual_unresolved'));
  assert.ok(codes[0].includes('source_table_unresolved'));
  assert.ok(!codes[1].includes('source_visual_unresolved'));
  assert.ok(!codes[1].includes('source_table_unresolved'));
  assert.ok(codes[2].includes('source_page_missing'));
});
