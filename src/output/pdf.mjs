import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile, access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';
import { studentProblem } from '../assembly/papers.mjs';
import { questionSourcePresentation } from '../question-bank/source-label.mjs';
import { paperTextBlocks } from './rich-text.mjs';

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const math = mathjax.document('', { InputJax: new TeX({ packages: AllPackages.filter(x => !['require','autoload','html','noerrors','noundefined'].includes(x)), formatError: (_jax,error) => { throw error; } }), OutputJax: new SVG({ fontCache: 'none' }) });

// Layout revisions do not alter the frozen paper; explicit regeneration writes a new file.
export const PDF_LAYOUT_VERSION = 'formal-exam-v7-rich-tables';

export async function findPdfPython() {
  if (process.env.TUTOR_PYTHON) return process.env.TUTOR_PYTHON;
  const bundled = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python');
  try { await access(bundled); return bundled; } catch { return process.platform === 'win32' ? 'python' : 'python3'; }
}

// Deliberately construct a new student projection: no teacher, provenance, trace, or bank notes can cross this boundary.
export function projectPaper(paper, kind) {
  if (!['student','teacher'].includes(kind) || !/^[a-zA-Z0-9-]{1,100}$/.test(paper?.paperId ?? '') || !paper?.draft?.slots) throw new Error('无效成卷或输出类型');
  const draft = paper.draft;
  const scored = draft.baseline.requirements.scoringMode !== 'none';
  const issues = [];
  const summaryIssues = paper.summary?.teacher?.issues ?? [];
  const hasSummaryIssue = (slotId, code) => summaryIssues.some(issue => issue && typeof issue === 'object' && issue.slotId === slotId && issue.code === code);
  const slots = draft.slots.map(slot => {
    const q = slot.question;
    const frozenMissing = paper.summary?.student?.missing?.find(item => item.slotId === slot.slotId);
    const problem = studentProblem(slot) ?? frozenMissing?.reason ?? (slot.status !== 'selected' ? '题位未选入题目' : null);
    const base = { number: slot.number, slotId: slot.slotId, questionType: slot.questionType, points: slot.points, partPoints: structuredClone(slot.partPoints ?? []), missing: Boolean(problem) };
    if (base.missing) { issues.push(`第 ${slot.number} 题：${problem}`); return { ...base, student: null }; }
    const student = q.student;
    const presentation = questionSourcePresentation(q, draft.baseline.sourceManifest);
    const sourceBreak = paperTextBlocks(presentation.stem)[0]?.type === 'table' ? '\n' : '';
    const result = { ...base, student: { stem: `（${presentation.label}）${sourceBreak}${presentation.stem}`, options: (student.options ?? []).map(x => ({label:x.label,text:x.text})), parts: (student.parts ?? []).map(x => ({partId:x.partId,prompt:x.prompt})), assets: (student.assets ?? []).map(x => ({assetId:x.assetId,alt:x.alt ?? ''})) } };
    if (kind === 'teacher') {
      result.teacher = structuredClone(q.teacher ?? {answers:[],solutions:[],scoringSuggestions:[]});
      if (draft.baseline.requirements.purpose === 'diagnostic' && slot.taskLabel) result.diagnosticFocus = slot.taskLabel;
      if (!scored) delete result.teacher.scoringSuggestions;
      result.sourceRefs = structuredClone(q.sourceRefs ?? []);
      result.sourceDescription = presentation.caption;
      result.versions = { questionId:q.questionId, contentVersion:q.contentVersion, teacherVersion:q.teacherVersion };
      if (!result.teacher.answers?.length && !hasSummaryIssue(slot.slotId,'answer_missing')) issues.push(`第 ${slot.number} 题缺参考答案`);
      if (!result.teacher.solutions?.length && !hasSummaryIssue(slot.slotId,'solution_missing')) issues.push(`第 ${slot.number} 题缺参考解析`);
      if (scored && !result.teacher.scoringSuggestions?.length && !hasSummaryIssue(slot.slotId,'rubric_missing')) issues.push(`第 ${slot.number} 题缺建议评分`);
    }
    return result;
  });
  const selected = slots.filter(x => !x.missing);
  const assetRefs = slots.flatMap(slot => (slot.student?.assets ?? []).map(asset=>`${slot.slotId}:${asset.assetId}`));
  const assets = (paper.assets ?? []).filter(a => assetRefs.includes(`${a.slotId}:${a.assetId}`)).map(a => {
    const bytes = Buffer.from(a.dataBase64 ?? '', 'base64');
    if (!a.sha256 || createHash('sha256').update(bytes).digest('hex') !== a.sha256) throw new Error('冻结图片校验失败');
    return { slotId:a.slotId,assetId:a.assetId,alt:a.alt ?? '',mimeType:a.mimeType,dataBase64:a.dataBase64 };
  });
  for (const ref of assetRefs) if (!assets.some(a => `${a.slotId}:${a.assetId}` === ref)) throw new Error('冻结题面图片缺失');
  if (kind === 'teacher') {
    const seen = new Set();
    for (const issue of summaryIssues) {
      if (typeof issue === 'string') { issues.push(issue); continue; }
      const key = `${issue.slotId}:${issue.code}:${issue.partId ?? 'main'}`;
      if (seen.has(key) || (issue.code === 'student_incomplete' && slots.some(slot=>slot.slotId===issue.slotId && slot.missing))) continue;
      seen.add(key);
      const number = issue.number ?? slots.find(slot=>slot.slotId===issue.slotId)?.number;
      const part = issue.partId && issue.partId !== 'main' ? `（小问 ${issue.partId.replace(/^p/, '')}）` : '';
      const message = issue.message ?? issue.reason ?? issue.reasons?.join('；') ?? '教师材料未完整';
      issues.push(`${number ? `第 ${number} 题${part}：` : ''}${message}`);
    }
  }
  const uniqueIssues = [...new Set(issues)];
  return { schemaVersion:1,paperId:paper.paperId,kind,scoringMode:scored ? 'points' : 'none',title:paper.title ?? draft.title,createdAt:paper.createdAt,durationMinutes:draft.baseline.requirements.durationMinutes,questionCount:selected.length,points:selected.reduce((sum,x)=>sum+x.points,0),plannedQuestions:slots.length,plannedPoints:slots.reduce((sum,x)=>sum+x.points,0),status:uniqueIssues.length?'incomplete':'complete',issues:uniqueIssues,slots,assets, ...(kind==='teacher'?{summary:structuredClone(paper.summary ?? {})}:{}) };
}

export async function generatePaperOutput(paper, kind, {outputRoot = path.join(repoRoot,'.tutor','outputs')} = {}) {
  let temp;
  let targetTemp;
  try {
    const model = projectPaper(paper, kind);
    const formulas = new Map();
    const richTextBlocks = Object.create(null);
    const scanFormulas = value => {
      for (const match of value.matchAll(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g)) {
        const tex = match[1] ?? match[2];
        if (!formulas.has(tex)) {
          const node = math.convert(tex,{display:Boolean(match[1]),em:11,ex:5.5,containerWidth:500});
          let svg = adaptor.outerHTML(adaptor.firstChild(node));
          if (svg.includes('data-mjx-error') || svg.includes('data-mml-node="merror"')) throw new Error(`公式无法排版：${tex}`);
          svg = svg.replace(/(width|height)="([\d.]+)ex"/g, (_m,key,n)=>`${key}="${Number(n)*5.5}pt"`);
          formulas.set(tex,svg);
        }
      }
    };
    const scan = value => {
      if (typeof value === 'string') {
        const blocks = paperTextBlocks(value);
        if (blocks.some(block => block.type === 'table')) richTextBlocks[value] = blocks;
        for (const block of blocks) {
          if (block.type === 'text') scanFormulas(block.text);
          else for (const row of block.rows) for (const cell of row) scanFormulas(cell.text);
        }
        // The renderer removes this known system disclaimer from scoring text.
        // Keep a parsed entry for the remaining question-specific material too.
        const disclaimer = '仅引用本次标杆的建议赋分，非原卷评分，也不是题目固定分值；新草稿另设题位分值。';
        if (value.startsWith(disclaimer)) scan(value.slice(disclaimer.length).trim());
      } else if (Array.isArray(value)) value.forEach(scan);
      else if (value && typeof value === 'object') Object.values(value).forEach(scan);
    };
    scan(model);
    temp = await mkdtemp(path.join(tmpdir(),'tutor-pdf-'));
    await writeFile(path.join(temp,'input.json'),JSON.stringify({...model,richTextBlocks,formulas:Object.fromEntries(formulas)}),'utf8');
    await mkdir(outputRoot,{recursive:true});
    const target = path.resolve(outputRoot,`${paper.paperId}-${kind}-${PDF_LAYOUT_VERSION}-${randomUUID()}.pdf`);
    targetTemp = `${target}.${randomUUID()}.tmp`;
    const python = await findPdfPython();
    const result = await exec(python,[path.join(repoRoot,'scripts','render-paper.py'),path.join(temp,'input.json'),targetTemp],{windowsHide:true,maxBuffer:1024*1024,timeout:120000,encoding:'utf8',env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'}});
    const metadata = JSON.parse(result.stdout.trim());
    const bytes = await readFile(targetTemp);
    if (!bytes.subarray(0,5).equals(Buffer.from('%PDF-'))) throw new Error('输出不是有效 PDF');
    await rename(targetTemp,target);
    targetTemp = undefined;
    return {ok:true,artifact:{path:target,sha256:createHash('sha256').update(bytes).digest('hex'),pages:metadata.pages,status:model.status,issues:model.issues,kind,bytes:bytes.length,layoutVersion:PDF_LAYOUT_VERSION}};
  } catch (error) {
    return {ok:false,error:{code:'output_failed',message:`${kind === 'teacher'?'教师':'学生'}版输出失败：${error.message}`}};
  } finally {
    if (targetTemp) await rm(targetTemp,{force:true}).catch(()=>{});
    if (temp) await rm(temp,{recursive:true,force:true}).catch(()=>{});
  }
}
