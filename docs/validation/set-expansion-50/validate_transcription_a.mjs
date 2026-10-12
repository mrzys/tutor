import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import katex from 'katex';
const file='data/question-bank/staging/set-expansion-50-001-025.json';
const data=JSON.parse(fs.readFileSync(file,'utf8'));
assert.equal(data.items.length,25);
assert.equal(new Set(data.items.map(x=>x.id)).size,25);
let formulas=0;
for(const item of data.items){
  assert.equal(item.reviewStatus,'pending_review');
  assert.equal(item.verification.sourceVisualChecked,true);
  assert.equal(item.student.options.length,4);
  assert.equal(item.source.sha256,crypto.createHash('sha256').update(fs.readFileSync(item.source.path)).digest('hex'));
  for(const answer of item.teacher.answers){
    if(answer.provenance==='source'){
      assert.ok(fs.existsSync(answer.sourceFile));assert.ok(answer.pages.length>0);
      assert.equal(item.verification.answerStatus,'source_checked');
      assert.ok(item.student.options.some(o=>o.label===answer.text));
    }else{
      assert.equal(answer.sourceFile,null);assert.equal(answer.pages.length,0);
      assert.equal(item.verification.answerStatus,'independent_proposed');
    }
  }
  for(const text of [item.student.stem,...item.student.options.map(o=>o.text),...item.teacher.answers.map(x=>x.text)]){
    assert.equal((text.match(/\$/g)||[]).length%2,0,`${item.id}: unbalanced dollar delimiter`);
    for(const [,formula] of text.matchAll(/\$([^$]+)\$/g)){
      katex.renderToString(formula,{throwOnError:true,trust:false,strict:'error'});formulas++;
    }
  }
}
assert.deepEqual(data.items.filter(x=>x.verification.blockingIssues.length).map(x=>x.id),['SET-EXP50-010','SET-EXP50-019']);
assert.deepEqual(data.items.find(x=>x.id==='SET-EXP50-019').verification.sourceIssues,['unstated_cardinality_assumption']);
console.log(`PASS: 25 records, ${formulas} KaTeX formulas, unchanged source hashes, answer provenance and defect gate.`);
