import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { previewBlueprint, createDraft } from '../src/assembly/engine.mjs';
import { generatePaperOutput, projectPaper, findPdfPython, PDF_LAYOUT_VERSION } from '../src/output/pdf.mjs';
import { preparePaperConfirmation } from '../src/assembly/papers.mjs';

const exec = promisify(execFile);
async function fixture() {
  const d = (await createDraft((await previewBlueprint()).blueprint)).draft;
  return {paperId:'test-frozen-paper',createdAt:new Date().toISOString(),title:d.title,draft:d,summary:{}};
}
async function inspect(pdf) {
  const script = 'import sys,json;from pypdf import PdfReader;r=PdfReader(sys.argv[1]);print(json.dumps({"pages":[{"width":float(p.mediabox.width),"height":float(p.mediabox.height),"text":p.extract_text(extraction_mode="layout")} for p in r.pages]}))';
  return JSON.parse((await exec(await findPdfPython(),['-c',script,pdf],{encoding:'utf8',windowsHide:true})).stdout);
}

test('student projection excludes all teacher notes, traces, and unused assets',async()=>{
  const paper = await fixture();
  paper.draft.slots[0].question.teacher.answers[0].text = 'TEACHER_SECRET_SENTINEL';
  paper.draft.slots[0].selection.privateSentinel = 'PRIVATE_TRACE_SENTINEL';
  paper.assets = [{assetId:'teacher-only',dataBase64:'invalid',sha256:'invalid'}];
  const projected = JSON.stringify(projectPaper(paper,'student'));
  assert.doesNotMatch(projected,/SECRET_SENTINEL|TRACE_SENTINEL|teacher-only|sourceRefs|contentVersion/);
  assert.match(JSON.stringify(projectPaper(paper,'teacher')),/TEACHER_SECRET_SENTINEL/);
});

test('PDF uses a compact inline source while preserving full source metadata in the frozen paper', async () => {
  const paper = await fixture();
  const slot = paper.draft.slots.find(item => item.question);
  slot.question.student.stem = '判断集合元素关系，选择正确选项。';
  slot.question.verification.origin = { sourceTitle: '2025学年五校十月联考数学', sourceQuestionNumber: '3', privateReviewNote: 'SOURCE_PRIVATE_SENTINEL' };
  for (const kind of ['student', 'teacher']) {
    const projection = projectPaper(paper, kind);
    assert.equal(projection.slots[0].student.stem, '（2025·五校十月联考）判断集合元素关系，选择正确选项。');
    assert.equal(projection.slots[0].sourceCaption, undefined);
    if (kind === 'teacher') assert.equal(projection.slots[0].sourceDescription, '来源：2025学年五校十月联考数学 · 原卷第 3 题');
    assert.doesNotMatch(JSON.stringify(projection), /SOURCE_PRIVATE_SENTINEL/);
    const root = await mkdtemp(path.join(tmpdir(), 'tutor-source-pdf-'));
    const output = await generatePaperOutput(paper, kind, { outputRoot: root });
    assert.equal(output.ok, true, output.error?.message);
    const text = (await inspect(output.artifact.path)).pages.map(page => page.text).join('\n');
    assert.match(text, /2025·五校十月联考/);
    assert.doesNotMatch(text, /来源：2025学年|原卷第\s*3\s*题/);
    assert.equal((text.match(/2025·五校十月联考/g) ?? []).length, 1);
  }
  assert.equal(slot.question.student.stem, '判断集合元素关系，选择正确选项。');
  assert.equal(slot.question.verification.origin.sourceTitle, '2025学年五校十月联考数学');
});

test('real A4 PDFs retain order and points; student leaks no teacher content, teacher has formal answer hierarchy and no technical metadata',async()=>{
  const paper = await fixture();
  paper.draft.slots[0].question.teacher.answers[0].text += ' TEACHER_SECRET_SENTINEL';
  paper.summary = preparePaperConfirmation(paper.draft);
  const teacherProjection = projectPaper(paper,'teacher');
  assert.equal(teacherProjection.issues.length,3);
  assert.ok(teacherProjection.issues.every(issue=>!issue.includes('{') && !issue.includes('slotId')));
  const root = await mkdtemp(path.join(tmpdir(),'tutor-output-test-'));
  const student = await generatePaperOutput(paper,'student',{outputRoot:root});
  const teacher = await generatePaperOutput(paper,'teacher',{outputRoot:root});
  assert.equal(student.ok,true,student.error?.message);
  assert.equal(teacher.ok,true,teacher.error?.message);
  assert.equal(student.artifact.status,'complete');
  assert.equal(teacher.artifact.status,'incomplete');
  const s = await inspect(student.artifact.path);
  const t = await inspect(teacher.artifact.path);
  for (const page of [...s.pages,...t.pages]) {assert.ok(Math.abs(page.width-595.276)<.01);assert.ok(Math.abs(page.height-841.89)<.01);}
  const st = s.pages.map(x=>x.text).join('\n');
  const tt = t.pages.map(x=>x.text).join('\n');
  assert.doesNotMatch(st,/TEACHER_SECRET_SENTINEL|参考答案|参考解析|建议评分|原卷整理|source_adapted|版本：|原题全文/);
  assert.match(tt,/TEACHER_SECRET_SENTINEL/);
  assert.match(tt,/答案速查/);
  assert.match(tt,/试题与解析/);
  assert.match(tt,/参考答案/);
  assert.equal((tt.match(/评分说明：/g) ?? []).length,1);
  assert.doesNotMatch(tt,/仅引用本次标杆的建议赋分/);
  assert.doesNotMatch(tt,/Tutor|test-frozen-paper|版本：|来源：|source_adapted|输出前确认记录/);
  assert.doesNotMatch(tt,/"slotId"|"rubric_missing"|"message"/);
  assert.match(st,/共 10 题.*满分：100 分/);
  assert.match(st,/或/); // CJK inside a MathJax mtext must survive SVG/PDF conversion.
  for (const text of [st,tt]) {
    let last = -1;
    for (let n=1;n<=10;n++) {const at=text.indexOf(`${n}.`);assert.ok(at>last,`question ${n} out of order`);last=at;}
  }
  // No split choice question: all four options for question 4 remain on its page.
  const q4 = s.pages.find(x=>x.text.includes('4.'));
  assert.match(q4.text,/A\./);assert.match(q4.text,/D\./);
});

test('missing teacher data does not block student; incomplete student retains empty number and effective points',async()=>{
  const paper = await fixture();
  paper.draft.slots[0].question.teacher = {answers:[],solutions:[],scoringSuggestions:[]};
  paper.draft.slots[7].question = null;
  paper.draft.slots[7].status = 'empty';
  const root = await mkdtemp(path.join(tmpdir(),'tutor-output-missing-'));
  const student = await generatePaperOutput(paper,'student',{outputRoot:root});
  assert.equal(student.ok,true,student.error?.message);
  assert.equal(student.artifact.status,'incomplete');
  const text = (await inspect(student.artifact.path)).pages.map(x=>x.text).join('\n');
  assert.match(text,/共 9 题.*满分：90 分/);assert.match(text,/未完整卷/);assert.match(text,/8\./);assert.match(text,/题面缺失/);assert.match(text,/9\./);
  assert.doesNotMatch(text,/参考答案缺失/);
});

test('unsupported formula and missing frozen assets fail explicitly without producing an artifact',async()=>{
  const paper = await fixture();
  const root = await mkdtemp(path.join(tmpdir(),'tutor-output-failure-'));
  paper.draft.slots[0].question.student.stem = '$\\notARealTutorCommand{x}$';
  const result = await generatePaperOutput(paper,'student',{outputRoot:root});
  assert.equal(result.ok,false);assert.equal(result.error.code,'output_failed');
  paper.draft.slots[0].question.student.stem = '题面';
  paper.draft.slots[0].question.student.assets = [{assetId:'missing-image',alt:'图'}];
  assert.throws(()=>projectPaper(paper,'student'),/冻结题面图片缺失/);
});

test('incomplete choice options match confirmation and become an explicit 9-question 92-point PDF',async()=>{
  const paper = await fixture();
  paper.draft.slots[0].question.student.options = [];
  paper.summary = preparePaperConfirmation(paper.draft);
  assert.equal(paper.summary.student.complete,false);
  assert.equal(paper.summary.student.questionCount,9);
  assert.equal(paper.summary.student.points,92);
  const projected = projectPaper(paper,'student');
  assert.equal(projected.status,'incomplete');
  assert.equal(projected.questionCount,9);
  assert.equal(projected.points,92);
  assert.equal(projected.slots[0].missing,true);
  const root = await mkdtemp(path.join(tmpdir(),'tutor-output-options-'));
  const output = await generatePaperOutput(paper,'student',{outputRoot:root});
  assert.equal(output.ok,true,output.error?.message);
  assert.equal(output.artifact.status,'incomplete');
  const text = (await inspect(output.artifact.path)).pages.map(x=>x.text).join('\n');
  assert.match(text,/共 9 题.*满分：92 分/);
  assert.match(text,/未完整卷/);
  assert.match(text,/1\.\s*【题面缺失/);
  assert.match(text,/题面缺失/);
  assert.doesNotMatch(text,/南充校级期中/);
  // Frozen missing state is honored even if a caller restores question bytes in memory.
  const restored = await fixture();
  restored.summary = paper.summary;
  assert.equal(projectPaper(restored,'student').slots[0].missing,true);
});

test('option layout measures rendered formula width and tallest formula height for 4, 2 and 1 columns',async()=>{
  const renderer=path.resolve('scripts/render-paper.py');
  const script=`import importlib.util,json,sys
s=importlib.util.spec_from_file_location('exam_renderer',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
formulas={'fraction':'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="36"><path d="M0 18H20" stroke="black"/></svg>','wide':'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="20"><path d="M0 10H260" stroke="black"/></svg>'}
results=[]
for text in ['短选项','这是长度适中的选项用于检验两列布局','这是很长的完整句子选项内容用于检验每个选项独占一行且文字自然换行不会覆盖邻近选项',' $fraction$',' $wide$']:
 g=m.ChoiceGrid([{'label':x,'text':text} for x in 'ABCD'],formulas);g.wrap(491,700);results.append({'columns':g.columns,'height':g.height})
print(json.dumps(results))`;
  const values=JSON.parse((await exec(await findPdfPython(),['-c',script,renderer],{encoding:'utf8',windowsHide:true})).stdout);
  assert.deepEqual(values.map(x=>x.columns),[4,2,1,4,1]);
  assert.ok(values[3].height>values[0].height,'a tall fraction raises its option row height');
});

test('CJK-only font falls back for numbers, source years, option labels and SVG text',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'tutor-font-fallback-'));
  const file=path.join(root,'fallback.pdf');
  const script=`import importlib.util,json,sys
from reportlab.pdfgen import canvas
from reportlab.graphics.shapes import Group,String
s=importlib.util.spec_from_file_location('exam_renderer',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
# Reproduce DroidSansFallbackFull's missing Latin cmap on every platform.
for name in [m.FONT,m.BOLD]:
 face=m.pdfmetrics.getFont(name).face
 face.charToGlyph={code:glyph for code,glyph in face.charToGlyph.items() if code>=128}
text='1. 2025 ABCD 10'
for preferred in [m.FONT,m.BOLD]:
 runs=m.font_runs(text,preferred)
 assert ''.join(run for run,font in runs)==text
 assert all(font not in [m.FONT,m.BOLD] for run,font in runs)
 assert all(m.pdfmetrics.getFont(font).face.charToGlyph.get(ord(c),0) for run,font in runs for c in run)
 assert m.font_runs('中文',preferred)==[('中文',preferred)]
 assert abs(m.text_width(text,preferred,12)-sum(m.pdfmetrics.stringWidth(run,font,12) for run,font in runs))<0.001
g=Group();g.add(String(100,0,'中文2025',fontName=m.FONT,fontSize=12,textAnchor='middle'));m.fallback_svg_text(g)
assert ''.join(item.text for item in g.contents[0].contents)=='中文2025'
assert g.contents[0].contents[-1].fontName==m.LATIN
c=canvas.Canvas(sys.argv[2]);m.draw_text(c,50,750,text,m.FONT,12);m.draw_text(c,50,720,text,m.BOLD,12);c.save()
try: m.font_runs(chr(0x10ffff));raise AssertionError('unsupported glyph silently accepted')
except RuntimeError: pass
print(json.dumps({'ok':True}))`;
  assert.equal(JSON.parse((await exec(await findPdfPython(),['-c',script,path.resolve('scripts/render-paper.py'),file],{encoding:'utf8',windowsHide:true})).stdout).ok,true);
  const text=(await inspect(file)).pages.map(page=>page.text).join('\n');
  assert.equal((text.match(/1\. 2025 ABCD 10/g)??[]).length,2);
});


test('diagnostic focus is teacher-only and bound to the frozen task, including real PDF output', async () => {
  const paper = await fixture();
  paper.draft.baseline.requirements.purpose = 'diagnostic';
  paper.draft.slots[0].taskLabel = '诊断检查点_SENTINEL';
  const student = projectPaper(paper, 'student');
  const teacher = projectPaper(paper, 'teacher');
  assert.equal(student.slots[0].diagnosticFocus, undefined);
  assert.equal(teacher.slots[0].diagnosticFocus, '诊断检查点_SENTINEL');
  const root = await mkdtemp(path.join(tmpdir(), 'tutor-diagnostic-output-'));
  const result = await generatePaperOutput(paper, 'teacher', { outputRoot: root });
  assert.equal(result.ok, true, result.error?.message);
  const pdf = await inspect(result.artifact.path);
  assert.match(pdf.pages.map(page => page.text).join('\n'), /诊断检查点_SENTINEL/);
  paper.draft.baseline.requirements.purpose = 'consolidation';
  assert.equal(projectPaper(paper, 'teacher').slots[0].diagnosticFocus, undefined);
});

test('PDF shares preview table parsing for HTML spans, Markdown math pipes, parts and teacher materials', async () => {
  const paper = await fixture();
  const markdown = '| 数值 | 结论 |\n| --- | --- |\n| $|x|$ | 数学单元格 |';
  const html = '<table onclick="bad()"><tr><th colspan="2">合并标题 &amp; 数据</th></tr><tr><td rowspan="2">纵向单元格</td><td>上行内容 $x<0$ 或 $x>1$</td></tr><tr><td>下行内容<script>EXECUTABLE_SENTINEL</script></td></tr></table>';
  paper.draft.slots[0].question.student.stem = markdown;
  paper.draft.slots[1].question.student.stem = `表格前文${html}表格后文`;
  paper.draft.slots[0].question.student.options[0].text = `选项表格${html}`;
  const free = paper.draft.slots.find(slot => slot.questionType === 'free_response');
  free.question.student.parts[0].prompt = `小问表格${html}`;
  paper.draft.slots[0].question.teacher.solutions = [{partId:'p1',text:`教师表格${html}`}];
  const root = await mkdtemp(path.join(tmpdir(), 'tutor-rich-table-output-'));
  for (const kind of ['student','teacher']) {
    const output = await generatePaperOutput(paper, kind, {outputRoot:root});
    assert.equal(output.ok, true, output.error?.message);
    assert.equal(output.artifact.layoutVersion, PDF_LAYOUT_VERSION);
    const text = (await inspect(output.artifact.path)).pages.map(page => page.text).join('\n');
    for (const token of ['数学单元格','合并标题','纵向单元格','上行内容','下行内容','表格前文','表格后文','选项表格','小问表格']) assert.ok(text.includes(token), `${kind} missing ${token}`);
    assert.doesNotMatch(text, /<table|<td|<th|<script|EXECUTABLE_SENTINEL|onclick|---/);
    if (kind === 'teacher') assert.match(text, /教师表格/);
    else assert.doesNotMatch(text, /教师表格/);
  }
});

test('PDF table layout preserves merged coordinates and header row semantics', async () => {
  const script = `import importlib.util,json,sys
s=importlib.util.spec_from_file_location('exam_renderer',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
rows=[[{'text':'合并标题','header':True,'colSpan':2}],[{'text':'纵向','rowSpan':2},{'text':'上行'}],[{'text':'下行'}]]
t=m.rich_table(rows,{},460)
assert t._ncols==2 and t._nrows==3
assert ('SPAN',(0,0),(1,0)) in t._spanCmds
assert ('SPAN',(0,1),(0,2)) in t._spanCmds
assert t._cellvalues[2][1].text=='下行'
assert t.repeatRows==1
t.wrap(460,700)
print(json.dumps({'ok':True}))`;
  assert.equal(JSON.parse((await exec(await findPdfPython(), ['-c',script,path.resolve('scripts/render-paper.py')], {encoding:'utf8',windowsHide:true})).stdout).ok,true);
});
