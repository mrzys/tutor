import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { previewBlueprint, createDraft } from '../src/assembly/engine.mjs';
import { generatePaperOutput, projectPaper, findPdfPython } from '../src/output/pdf.mjs';
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

test('real A4 PDFs retain order and points; student leaks no teacher content, teacher marks provenance and missing rubric',async()=>{
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
  assert.match(tt,/原卷整理增补/);
  assert.match(tt,/评分建议缺失/);
  assert.match(tt,/本卷赋分/);
  assert.match(tt,/未自动套用/);
  assert.doesNotMatch(tt,/"slotId"|"rubric_missing"|"message"/);
  assert.match(st,/10 题 \/ 100 分/);
  assert.match(st,/或/); // CJK inside a MathJax mtext must survive SVG/PDF conversion.
  for (const text of [st,tt]) {
    let last = -1;
    for (let n=1;n<=10;n++) {const at=text.indexOf(`第 ${n} 题（`);assert.ok(at>last,`question ${n} out of order`);last=at;}
  }
  // No split choice question: all four options for question 4 remain on its page.
  const q4 = s.pages.find(x=>x.text.includes('第 4 题'));
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
  assert.match(text,/9 题 \/ 90 分/);assert.match(text,/未完整卷/);assert.match(text,/第 8 题/);assert.match(text,/题面缺失/);assert.match(text,/第 9 题/);
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
  assert.match(text,/9 题 \/ 92 分/);
  assert.match(text,/未完整卷/);
  assert.match(text,/第 1 题（8 分）/);
  assert.match(text,/题面缺失/);
  assert.doesNotMatch(text,/南充校级期中/);
  // Frozen missing state is honored even if a caller restores question bytes in memory.
  const restored = await fixture();
  restored.summary = paper.summary;
  assert.equal(projectPaper(restored,'student').slots[0].missing,true);
});
