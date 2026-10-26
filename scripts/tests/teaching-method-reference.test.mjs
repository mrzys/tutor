import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTeachingMethodReferences, appendTeachingMethodReferences} from '../lib/teaching-method-reference.mjs';

test('explicit algebra reference loads actual teaching instructions and preserves empty-prompt variant', async () => {
  const base='模拟主提示词。\n';
  assert.equal(appendTeachingMethodReferences(base, await loadTeachingMethodReferences()), base);
  const refs=await loadTeachingMethodReferences(['algebra']);
  assert.equal(refs.length,1);
  assert.match(refs[0].sourceSha256,/^[a-f0-9]{64}$/u);
  const result=appendTeachingMethodReferences(base, refs);
  assert(result.startsWith(base));
  assert(result.includes(refs[0].text));
  assert.match(result,/乘以这个等于1的式子并展开/u);
  assert.match(result,/展开它的平方/u);
  assert(!result.includes('### 2. 数列'));
});

test('all eight explicit sections load without mixing adjacent fenced blocks', async () => {
  const ids=['algebra','sequences','functions','analytic_geometry','trigonometry','vectors_geometry','probability_statistics','sets_logic_complex'];
  const refs=await loadTeachingMethodReferences(ids);
  assert.deepEqual(refs.map(ref=>ref.id),ids);
  assert.equal(new Set(refs.map(ref=>ref.text)).size,8);
  assert(refs.every(ref=>!ref.text.includes('```')&&!ref.text.includes('###')));
});

test('unknown or repeated reference selections fail explicitly rather than routing from question content', async () => {
  for(const ids of [['unknown'],['algebra','algebra'],'algebra',null])
    await assert.rejects(loadTeachingMethodReferences(ids),{code:'invalid_method_reference_ids'});
  assert.throws(()=>appendTeachingMethodReferences('模拟',[{id:'unknown',text:'bad',label:'bad'}]),{code:'invalid_method_reference_prompt'});
});
