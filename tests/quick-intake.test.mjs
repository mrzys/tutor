import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeService, verifiedProgression, scopeTitle } from '../src/intake/service.mjs';
import { createLlmGateway } from '../src/llm/gateway.mjs';

let counter = 0;
const operation = () => `quick-test-${++counter}`;
async function begin(service, answers = {}) {
  const result = await service.handle({ action: 'start', flow: 'quick', answers, operationId: operation() });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.session;
}
async function request(service, session, action, payload = {}) {
  return service.handle({ action, sessionId: session.sessionId, revision: session.revision, operationId: operation(), ...payload });
}
const fixture = proposal => ({ configured: true, async propose(context, { validate }) {
  const parsed = validate(proposal);
  return { ok: true, proposal: parsed, run: { status: 'succeeded', provider: 'fixture', model: 'fixture-only' } };
} });

test('scope-derived default titles distinguish chapter one and two while teacher titles remain intact', async () => {
  const config = { defaultRequirements: { title: '高一数学 · 集合专项' }, chapters: [] };
  assert.equal(scopeTitle(['1.1', '1.2', '1.3'], config), config.defaultRequirements.title);
  assert.match(scopeTitle(['1.1', 'rja-compulsory-1:1.4', 'rja-compulsory-1:1.5'], config), /第一章集合与常用逻辑用语/);
  assert.match(scopeTitle(['rja-compulsory-1:2.1', 'rja-compulsory-1:2.3'], config), /第二章一元二次函数、方程和不等式/);
  const session = await begin(createIntakeService(), { title: '张老师的诊断练习', mainScope: ['1.1'] });
  assert.equal(session.answers.title, '张老师的诊断练习');
});

test('quick correction identifies forbidden locked fields and accepts only a corrected goal proposal', async () => {
  let attempts = 0;
  const gateway = createLlmGateway({ env: { LLM_BASE_URL: 'https://fixture.invalid/v1', LLM_API_KEY: 'fixture-key', LLM_MODEL: 'fixture' },
    generate: async input => {
      const context = JSON.parse(input.prompt);
      attempts++;
      if (attempts === 1) return { output: { summary: '六题含参练习，不计分。', changes: {
        questionCount: 6, scoringMode: 'none', cognition: 'reason', observable: '讨论含参集合的空集与非空分支。',
      }, blocks: [] } };
      const issue = context.schemaCorrection.issues[0].message;
      assert.match(issue, /禁止输出的字段：questionCount、scoringMode/);
      assert.match(issue, /即使值与当前相同也不能输出/);
      assert.match(input.system, /changes 必须是 supportedFields 的子集/);
      return { output: { summary: '六题含参练习，不计分。', changes: {
        cognition: 'reason', observable: '讨论含参集合的空集与非空分支。',
      }, blocks: [] } };
    } });
  const service = createIntakeService({ gateway });
  const session = await begin(service, { questionCount: 6 });
  const result = await request(service, session, 'prepare', { message: '6题集合提高，不计分。', lockedFields: ['questionCount', 'scoringMode'] });
  assert.equal(attempts, 2);
  assert.equal(result.session.llmRun.status, 'succeeded');
  assert.equal(result.session.llmRun.attempts[0].status, 'invalid_model_output');
  assert.deepEqual(Object.keys(result.session.proposal.changes).sort(), ['cognition', 'observable']);
  assert.equal(result.session.answers.questionCount, 6);
  assert.equal(result.session.requirements.scoringMode, 'none');
  assert.equal(result.session.requirements.teachingGoals.length, 0, 'proposal still needs explicit adoption');
});

test('quick intake uses verified textbook progression and does not assume special methods or response conditions', async () => {
  const service = createIntakeService({ gateway: createLlmGateway({ env: {} }) });
  let session = await begin(service, { mainScope: ['1.2'] });
  assert.equal(session.mode, 'quick');
  assert.equal(session.stage, 'scope');
  assert.deepEqual(session.blocks, []);
  assert.deepEqual(session.answers.learnedScope, ['1.1', '1.2']);
  assert.equal(session.progression.status, 'verified');
  assert.deepEqual(session.answers.premises, []);
  assert.equal(session.answers.response, 'unspecified');
  assert.equal(session.answers.prompt, 'unspecified');
  session = (await request(service, session, 'answer', { answers: { mainScope: ['1.3'] } })).session;
  assert.deepEqual(session.answers.learnedScope, ['1.1', '1.2', '1.3']);
  session = (await request(service, session, 'answer', { answers: { mainScope: ['1.1'] } })).session;
  assert.deepEqual(session.answers.learnedScope, ['1.1']);
  const premature = await request(service, session, 'confirm');
  assert.equal(premature.error.code, 'incomplete_intake');
});

test('custom learned boundaries survive scope changes and can explicitly return to progression defaults', async () => {
  const service = createIntakeService();
  let session = await begin(service, { mainScope: ['1.1'], learnedScopeMode: 'custom', learnedScope: ['1.1', '1.3'] });
  session = (await request(service, session, 'answer', { answers: { mainScope: ['1.3'] } })).session;
  assert.deepEqual(session.answers.learnedScope, ['1.1', '1.3']);
  assert.equal(session.progression.automatic, false);
  session = (await request(service, session, 'answer', { answers: { learnedScopeMode: 'progress' } })).session;
  assert.deepEqual(session.answers.learnedScope, ['1.1', '1.2', '1.3']);
  session = (await request(service, session, 'answer', { answers: { learnedScope: ['1.3'] } })).session;
  assert.equal(session.answers.learnedScopeMode, 'custom');
  assert.deepEqual(session.answers.learnedScope, ['1.3']);
});

test('quick total quantity preserves AI suggested ratios while explicit type counts remain fixed', async () => {
  const service = createIntakeService({ gateway: createLlmGateway({ env: {} }) });
  let session = await begin(service, { questionCount: 15 });
  assert.equal(session.summary.questionCount, 15);
  assert.equal(session.planning.countPolicy, 'suggested');
  assert.deepEqual(session.requirements.counts, { single_choice: 9, fill_blank: 3, free_response: 3 });
  session = (await request(service, session, 'prepare', { answers: { questionCount: 60, targetScore: 150, durationMinutes: 90 } })).session;
  assert.equal(session.summary.questionCount, 60);
  assert.equal(session.planning.countPolicy, 'suggested');
  assert.ok(Object.values(session.requirements.counts).every(count => count <= 30));
  assert.equal(session.requirements.targetScore, 150);
  session = (await request(service, session, 'answer', { answers: { size: 'custom', singleChoiceCount: 4, fillBlankCount: 2, freeResponseCount: 0 } })).session;
  assert.equal(session.answers.questionCount, 6);
  assert.equal(session.planning.countPolicy, 'fixed');
  assert.deepEqual(session.requirements.counts, { single_choice: 4, fill_blank: 2, free_response: 0 });
  session = (await request(service, session, 'answer', { answers: { size: 'recommend', questionCount: 1 } })).session;
  assert.equal(session.summary.questionCount, 1);
  assert.equal(session.planning.countPolicy, 'suggested');
  const invalid = await request(service, session, 'answer', { answers: { questionCount: 61 } });
  assert.equal(invalid.ok, false);
  assert.equal((await service.get(session.sessionId)).session.revision, session.revision);
});

test('progression uses verified contents order instead of lexicographic IDs and rejects ambiguous or unverified mapping', () => {
  const config = { chapters: [{ id: '2.10', label: '2.10 后续内容' }, { id: '2.2', label: '2.2 前置内容' }] };
  const book = { id: 'verified-book', tocVerification: { status: 'visually_checked' }, chapters: [{ sections: [
    { id: 'verified-book:2.2', number: '2.2', title: '前置内容' },
    { id: 'verified-book:2.10', number: '2.10', title: '后续内容' },
  ] }] };
  assert.deepEqual(verifiedProgression(config, { books: [book] }).orderedIds, ['2.2', '2.10']);
  assert.equal(verifiedProgression(config, { books: [book, { ...book, id: 'ambiguous-other-book' }] }).status, 'unavailable');
  assert.equal(verifiedProgression(config, { books: [{ ...book, tocVerification: { status: 'unverified' } }] }).status, 'unavailable');
  assert.equal(verifiedProgression({ chapters: [...config.chapters, { id: 'unmapped', label: '未映射知识' }] }, { books: [book] }).status, 'unavailable');
});

test('one prepare call saves basic inputs but keeps inferred teaching goals pending until adopted', async () => {
  let context;
  const service = createIntakeService({ gateway: { configured: true, async propose(input, { validate }) {
    context = input;
    const proposal = validate({ summary: '练习判断集合包含关系，能解释判断依据。', changes: {
      cognition: 'apply', observable: '判断给定有限集合的包含关系并核对元素。', priority: 'preferred',
    }, blocks: [] });
    return { ok: true, proposal, run: { status: 'succeeded' } };
  } } });
  let session = await begin(service);
  const preparation = { action: 'prepare', sessionId: session.sessionId, revision: session.revision,
    operationId: operation(), answers: { mainScope: ['1.2'], durationMinutes: 20 }, message: '' };
  session = (await service.handle(preparation)).session;
  assert.equal(context.task, 'quick_intake');
  assert.equal(context.message, '');
  assert.equal(session.assistantMessage, '');
  assert.equal(session.stage, 'review');
  assert.equal(session.answers.durationMinutes, 20);
  assert.deepEqual(session.requirements.teachingGoals, []);
  assert.equal(session.proposal.changes.cognition, 'apply');
  assert.deepEqual((await service.handle(preparation)).session, session, 'Prepare retries do not invoke the model twice');
  session = (await request(service, session, 'answer', { acceptProposal: true })).session;
  assert.equal(session.stage, 'review');
  assert.equal(session.requirements.teachingGoals[0].conditions.response, 'unspecified');
  assert.equal(session.requirements.teachingGoals[0].conditions.prompt, 'unspecified');
  session = (await request(service, session, 'confirm')).session;
  assert.equal(session.status, 'confirmed');
  assert.equal(session.requirements.teachingGoals[0].priority, 'preferred');
});

test('model failure preserves quick basic inputs and permits an explicit confirmation without adopting suggestions', async () => {
  for (const gateway of [createLlmGateway({ env: {} }), { async propose() { throw new Error('private provider detail'); } }]) {
    const service = createIntakeService({ gateway });
    let session = await begin(service);
    const prepared = await request(service, session, 'prepare', { answers: { mainScope: ['1.1'], durationMinutes: 15 }, message: '概念辨析' });
    assert.equal(prepared.ok, true);
    session = prepared.session;
    assert.equal(session.stage, 'review');
    assert.equal(session.answers.durationMinutes, 15);
    assert.deepEqual(session.answers.learnedScope, ['1.1']);
    assert.equal(session.proposal, null);
    assert.ok(session.assistantError);
    assert.ok(!JSON.stringify(session).includes('private provider detail'));
    const confirmed = await request(service, session, 'confirm');
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.session.status, 'confirmed');
  }
});

test('quick suggestions cannot turn clear inputs into a long form or weaken explicit hard conditions', async () => {
  const invalidProposals = [
    { summary: '逐项填写强度。', changes: { priority: 'preferred' }, blocks: [{ id: 'priority', kind: 'single_choice', field: 'priority', title: '目标强度', options: [{ id: 'preferred', label: '偏好' }], value: 'preferred' }] },
    { summary: '降低硬要求。', changes: { priority: 'preferred' }, blocks: [] },
    { summary: '改为只给结果。', changes: { response: 'answer' }, blocks: [] },
    { summary: '扩大已学范围。', changes: { learnedScope: ['1.1', '1.2', '1.3'] }, blocks: [] },
  ];
  for (const proposal of invalidProposals) {
    const service = createIntakeService({ gateway: fixture(proposal) });
    let session = await begin(service, { mainScope: ['1.1'], cognition: 'reason', priority: 'required', response: 'written_reasoning' });
    session = (await request(service, session, 'prepare', { message: '必须写出理由' })).session;
    assert.equal(session.proposal, null);
    assert.ok(session.assistantError);
    assert.equal(session.answers.priority, 'required');
    assert.equal(session.answers.response, 'written_reasoning');
    assert.deepEqual(session.answers.learnedScope, ['1.1']);
  }
});

test('quick revisions preserve mode and confirmed originals; changed basic inputs discard stale pending goals', async () => {
  const service = createIntakeService({ gateway: fixture({ summary: '解释集合概念。', changes: { cognition: 'understand', observable: '判断对象能否构成集合。' }, blocks: [] }) });
  let session = await begin(service, { mainScope: ['1.1'] });
  session = (await request(service, session, 'prepare')).session;
  session = (await request(service, session, 'answer', { answers: { mainScope: ['1.3'] } })).session;
  assert.equal(session.proposal, null);
  session = (await request(service, session, 'confirm')).session;
  const original = structuredClone(session);
  const edited = await service.handle({ action: 'revise', sessionId: session.sessionId, revision: session.revision, operationId: operation(), stage: 'goal' });
  assert.equal(edited.ok, true);
  assert.equal(edited.session.mode, 'quick');
  assert.equal(edited.session.answers.learnedScopeMode, 'progress');
  let changed = (await request(service, edited.session, 'answer', { answers: { mainScope: ['1.2'] }, next: true })).session;
  assert.equal(changed.stage, 'review');
  changed = (await request(service, changed, 'confirm')).session;
  assert.deepEqual(changed.requirements.learnedScope, ['1.1', '1.2']);
  assert.deepEqual((await service.get(original.sessionId)).session, original);
});

test('guided intake retains its explicit confirmation sequence', async () => {
  const service = createIntakeService();
  const result = await service.handle({ action: 'start', flow: 'guided', operationId: operation() });
  assert.equal(result.session.stage, 'purpose');
  assert.equal(result.session.answers.response, 'answer');
  assert.equal((await request(service, result.session, 'prepare')).error.code, 'invalid_intake');
  const review = (await request(service, result.session, 'answer', { stage: 'review' })).session;
  assert.equal((await request(service, review, 'confirm')).error.code, 'incomplete_intake');
});

test('quick goal assistance cannot quietly rewrite any clicked basic condition', async () => {
  const forbiddenChanges = [
    { mainScope: ['1.3'] }, { learnedScope: ['1.1', '1.2', '1.3'] }, { learnedScopeMode: 'custom' },
    { premises: ['vieta'] },
    { title: '偷偷改标题' }, { purpose: 'assessment' }, { size: 'custom' },
    { singleChoiceCount: 3 }, { fillBlankCount: 3 }, { freeResponseCount: 3 },
    { response: 'written_reasoning' }, { prompt: 'provided' },
  ];
  for (const changes of forbiddenChanges) {
    const service = createIntakeService({ gateway: fixture({ summary: '调整教学目标。', changes, blocks: [] }) });
    let session = await begin(service, { mainScope: ['1.1'] });
    const before = structuredClone(session.answers);
    session = (await request(service, session, 'prepare', { message: '重点练习集合概念' })).session;
    assert.equal(session.proposal, null, JSON.stringify(changes));
    assert.ok(session.assistantError);
    assert.deepEqual(session.answers, before);
  }
});

test('quick natural-language scale suggestions remain pending and preserve suggested ratio planning', async () => {
  let context;
  const service = createIntakeService({ gateway: { async propose(input, { validate }) {
    context = input;
    return { ok: true, proposal: validate({ summary: '练习交集运算，保持基础应用。', changes: {
      questionCount: 8, targetScore: 80, durationMinutes: 30, cognition: 'apply', observable: '计算给定集合的交集。',
    }, blocks: [] }), run: { status: 'succeeded' } };
  } } });
  let session = await begin(service);
  session = (await request(service, session, 'prepare', { message: '出8题，80分，30分钟，练习交集', lockedFields: [] })).session;
  assert.deepEqual(context.lockedFields, []);
  assert.ok(context.supportedFields.includes('questionCount'));
  assert.equal(session.answers.questionCount, 10);
  assert.equal(session.answers.targetScore, 0);
  assert.equal(session.answers.scoringMode, 'none');
  assert.equal(session.proposal.changes.scoringMode, 'points');
  assert.equal(session.answers.durationMinutes, 45);
  assert.match(session.proposal.summary, /8 题 · 80 分 · 30 分钟/);
  assert.equal(session.proposal.summary.split('规模：').length, 2, 'Repeated validation does not duplicate the scale summary');
  session = (await request(service, session, 'answer', { acceptProposal: true })).session;
  assert.equal(session.answers.questionCount, 8);
  assert.equal(session.answers.targetScore, 80);
  assert.equal(session.answers.durationMinutes, 30);
  assert.equal(session.planning.countPolicy, 'suggested');
  assert.equal(Object.values(session.requirements.counts).reduce((sum, count) => sum + count, 0), 8);
  session = (await request(service, session, 'confirm')).session;
  assert.equal(session.summary.questionCount, 8);
});

test('a total-only teacher request cannot acquire a model-invented fixed type ratio', async () => {
  let context;
  const service = createIntakeService({ gateway: { async propose(input, { validate }) {
    context = input;
    return { ok: true, proposal: validate({ summary: '集合含参提高练习。', changes: {
      singleChoiceCount: 4, fillBlankCount: 1, freeResponseCount: 1,
      observable: '对含参集合关系进行推理。', cognition: 'reason',
    }, blocks: [] }), run: { status: 'succeeded' } };
  } } });
  let session = await begin(service, { questionCount: 6 });
  session = (await request(service, session, 'prepare', { message: '6道集合提高题，要求推理说明，不计分。', lockedFields: ['questionCount'] })).session;
  assert.equal(context.typeCountsEditable, false);
  assert.ok(['singleChoiceCount', 'fillBlankCount', 'freeResponseCount'].every(field => !context.supportedFields.includes(field)));
  assert.equal(session.proposal, null);
  assert.equal(session.planning.countPolicy, 'suggested');
  assert.equal(session.answers.questionCount, 6);
});

test('manually locked quick scale values cannot be overwritten by model suggestions and survive revise', async () => {
  for (const [field, value] of [['questionCount', 8], ['targetScore', 80], ['durationMinutes', 30]]) {
    let context;
    const service = createIntakeService({ gateway: { async propose(input, { validate }) {
      context = input;
      return { ok: true, proposal: validate({ summary: '建议调整规模。', changes: { [field]: value }, blocks: [] }), run: { status: 'succeeded' } };
    } } });
    let session = await begin(service);
    const initial = session.answers[field];
    session = (await request(service, session, 'prepare', { message: '出8题80分30分钟', lockedFields: [field] })).session;
    assert.deepEqual(session.lockedFields, [field]);
    assert.ok(context.lockedFields.includes(field));
    assert.ok(!context.supportedFields.includes(field));
    assert.equal(session.answers[field], initial);
    assert.equal(session.proposal, null);
    session = (await request(service, session, 'confirm')).session;
    const edited = await service.handle({ action: 'revise', sessionId: session.sessionId, revision: session.revision, operationId: operation(), stage: 'review' });
    assert.deepEqual(edited.session.lockedFields, [field]);
  }
});

test('prescribed type ratios lock total quantity and malformed scale lock lists never persist', async () => {
  let context;
  const service = createIntakeService({ gateway: { async propose(input, { validate }) {
    context = input;
    return { ok: true, proposal: validate({ summary: '改成8题。', changes: { questionCount: 8 }, blocks: [] }), run: { status: 'succeeded' } };
  } } });
  let session = await begin(service, { size: 'custom', singleChoiceCount: 4, fillBlankCount: 2, freeResponseCount: 0 });
  session = (await request(service, session, 'prepare', { message: '改成8题', lockedFields: [] })).session;
  assert.ok(context.lockedFields.includes('questionCount'));
  assert.equal(session.proposal, null);
  assert.equal(session.answers.questionCount, 6);
  assert.deepEqual(session.requirements.counts, { single_choice: 4, fill_blank: 2, free_response: 0 });
  for (const lockedFields of [['mainScope'], ['questionCount', 'questionCount']]) {
    const rejected = await request(service, session, 'prepare', { lockedFields });
    assert.equal(rejected.ok, false);
    assert.equal((await service.get(session.sessionId)).session.revision, session.revision);
  }
});

test('quick goal assistance asks only an optional observable clarification, never cognition or size selectors', async () => {
  for (const [field, id] of [['cognition', 'reason'], ['size', 'recommend']]) {
    const service = createIntakeService({ gateway: fixture({ summary: '请继续填写。', changes: {}, blocks: [
      { id: `ask-${field}`, kind: 'single_choice', field, title: '请选择', options: [{ id, label: '选项' }] },
    ] }) });
    const session = (await request(service, await begin(service), 'prepare')).session;
    assert.equal(session.proposal, null);
    assert.ok(session.assistantError);
  }
  const service = createIntakeService({ gateway: fixture({ summary: '请补充希望学生完成的表现。', changes: {}, blocks: [
    { id: 'ask-goal', kind: 'text', field: 'observable', title: '学生需要做到什么？' },
  ] }) });
  const session = (await request(service, await begin(service), 'prepare')).session;
  assert.equal(session.proposal.blocks.length, 1);
  assert.equal(session.proposal.blocks[0].field, 'observable');
});

test('quick raw teacher wording survives local save and revise without being silently parsed into goals', async () => {
  const service = createIntakeService({ gateway: fixture({ summary: '判断集合的概念。', changes: { cognition: 'understand', observable: '判断对象是否构成集合。' }, blocks: [] }) });
  let session = await begin(service, { mainScope: ['1.1'] });
  session = (await request(service, session, 'answer', { message: '重点练习概念辨析', stage: 'review' })).session;
  assert.equal(session.assistantMessage, '重点练习概念辨析');
  assert.deepEqual(session.requirements.teachingGoals, []);
  session = (await request(service, session, 'prepare')).session;
  assert.equal(session.assistantMessage, '重点练习概念辨析');
  assert.ok(session.proposal);
  const outdated = await request(service, session, 'answer', { acceptProposal: true, message: '改成运算专项' });
  assert.equal(outdated.ok, false);
  assert.equal((await service.get(session.sessionId)).session.revision, session.revision);
  session = (await request(service, session, 'answer', { message: '改成运算专项' })).session;
  assert.equal(session.proposal, null, 'A changed raw request invalidates the old pending target');
  assert.deepEqual(session.requirements.teachingGoals, []);
  session = (await request(service, session, 'confirm')).session;
  const edited = await service.handle({ action: 'revise', sessionId: session.sessionId, revision: session.revision, operationId: operation(), stage: 'goal' });
  assert.equal(edited.ok, true);
  assert.equal(edited.session.assistantMessage, '改成运算专项');
  assert.deepEqual(edited.session.requirements.teachingGoals, []);
  assert.equal((await service.get(session.sessionId)).session.assistantMessage, '改成运算专项');
});

test('recovery reads wait for an in-flight prepare cancellation and return its saved revision without a stale proposal', async () => {
  let entered;
  let release;
  const modelEntered = new Promise(resolve => { entered = resolve; });
  const deferredResult = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const service = createIntakeService({ gateway: { async propose(_context, { validate }) {
    calls += 1;
    if (calls === 1) return { ok: true, proposal: validate({ summary: '练习交集运算。',
      changes: { cognition: 'apply', observable: '计算有限集合的交集。' }, blocks: [] }), run: { status: 'succeeded' } };
    entered();
    return deferredResult;
  } } });
  let session = await begin(service);
  session = (await request(service, session, 'prepare')).session;
  assert.ok(session.proposal, 'The old pending proposal must not survive a cancelled replacement');
  const other = await begin(service, { mainScope: ['1.1'] });
  const controller = new AbortController();
  const preparing = service.handle({ action: 'prepare', sessionId: session.sessionId, revision: session.revision,
    operationId: operation(), answers: { durationMinutes: 25 }, message: '重新整理', lockedFields: ['durationMinutes'] }, { signal: controller.signal });
  await modelEntered;
  let readSettled = false;
  const recovering = service.get(session.sessionId).then(result => { readSettled = true; return result; });
  const independentRead = await service.get(other.sessionId);
  assert.equal(independentRead.ok, true, 'A different session is not blocked by this model call');
  assert.equal(readSettled, false, 'Recovery waits for the same-session writer instead of reading old state');
  controller.abort();
  release({ ok: false, error: { code: 'cancelled', message: '已取消。' }, run: { status: 'cancelled' } });
  const prepared = await preparing;
  assert.equal(prepared.ok, true);
  const restored = await recovering;
  assert.equal(restored.ok, true);
  assert.equal(restored.session.revision, session.revision + 1);
  assert.equal(restored.session.revision, prepared.session.revision);
  assert.equal(restored.session.proposal, null);
  assert.equal(restored.session.assistantError.code, 'cancelled');
  assert.equal(restored.session.answers.durationMinutes, 25);
  const next = await request(service, restored.session, 'answer', { message: '继续整理' });
  assert.equal(next.ok, true, 'The recovered revision supports the next request without a revision conflict');
});
