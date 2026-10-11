import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeService } from '../src/intake/service.mjs';
import { createMemoryIntakeStorage } from '../src/intake/storage.mjs';
import { getAssemblyConfig, normalizeRequirements, previewBlueprint, recheckBlueprint } from '../src/assembly/engine.mjs';

let sequence = 0;
const operationId = () => `teacher-request-${++sequence}`;
const gateway = { configured: true, async propose(context, { validate }) {
  return { ok: true, proposal: validate({ summary: '已整理集合概念辨析目标。',
    changes: { observable: '判断对象能否构成集合并说明判断依据。', cognition: 'understand' }, blocks: [] }),
  run: { status: 'succeeded', model: 'fixture-only' } };
} };
async function act(service, session, action, extra = {}) {
  const result = await service.handle({ action, sessionId: session.sessionId, revision: session.revision,
    operationId: operationId(), ...extra });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.session;
}

test('teacher original request survives preparation, adoption, confirmation and blueprint normalization', async () => {
  const storage = createMemoryIntakeStorage();
  const service = createIntakeService({ storage, gateway });
  let session = (await service.handle({ action: 'start', flow: 'quick', operationId: operationId() })).session;
  const raw = '给高一学生出集合题；题干简洁、少复杂运算。';
  session = await act(service, session, 'prepare', { message: raw });
  assert.equal(session.requirements.teacherRequest, raw);
  session = await act(service, session, 'answer', { acceptProposal: true });
  session = await act(service, session, 'confirm');
  assert.equal(session.requirements.teacherRequest, raw);
  const preview = await previewBlueprint(session.requirements);
  assert.equal(preview.ok, true);
  assert.equal(preview.blueprint.requirements.teacherRequest, raw);
  const checked = await recheckBlueprint(preview.blueprint);
  assert.equal(checked.blueprint.requirements.teacherRequest, raw);

  // Confirmed requirements are a snapshot, not reconstructed from mutable auxiliary fields.
  const stored = await storage.get(session.sessionId);
  stored.assistantMessage = '存储中的辅助消息后来变化';
  await storage.put(stored);
  assert.equal((await service.get(session.sessionId)).session.requirements.teacherRequest, raw);
});

test('editing teacher original words refreshes collecting requirements without changing confirmed originals', async () => {
  const service = createIntakeService({ gateway });
  let session = (await service.handle({ action: 'start', flow: 'quick', operationId: operationId() })).session;
  session = await act(service, session, 'prepare', { message: '题干简洁。' });
  session = await act(service, session, 'answer', { message: '题干简洁、少复杂运算。' });
  assert.equal(session.requirements.teacherRequest, '题干简洁、少复杂运算。');
  assert.equal(session.proposal, null);
  session = await act(service, session, 'confirm');
  const revision = await service.handle({ action: 'revise', sessionId: session.sessionId,
    revision: session.revision, operationId: operationId(), stage: 'goal' });
  assert.equal(revision.ok, true);
  let edited = await act(service, revision.session, 'answer', { message: '允许少量综合运算。', next: true });
  assert.equal(edited.requirements.teacherRequest, '允许少量综合运算。');
  edited = await act(service, edited, 'confirm');
  assert.equal(edited.requirements.teacherRequest, '允许少量综合运算。');
  assert.equal((await service.get(session.sessionId)).session.requirements.teacherRequest, '题干简洁、少复杂运算。');
});

test('internal method-suggestion prompts never replace or invent a teacher request', async () => {
  for (const raw of [undefined, '题干简洁、少复杂运算。']) {
    let context;
    const service = createIntakeService({ gateway: { async propose(input, { validate }) {
      context = input;
      return { ok: true, proposal: validate({ summary: '无需新增额外知识与方法。', changes: {}, blocks: [] }), run: { status: 'succeeded' } };
    } } });
    let session = (await service.handle({ action: 'start', flow: 'quick', operationId: operationId() })).session;
    session = await act(service, session, 'answer', { stage: 'boundary', ...(raw !== undefined ? { message: raw } : {}) });
    const originalRequirements = structuredClone(session.requirements);
    const originalMessage = session.assistantMessage;
    session = await act(service, session, 'suggest_methods');
    assert.equal(context.task, 'suggest_methods');
    assert.match(context.message, /按本次考查范围与真实题目依赖/);
    assert.deepEqual(session.requirements, originalRequirements);
    assert.equal(session.teacherRequest, raw);
    assert.equal(session.assistantMessage, originalMessage);
    session = await act(service, session, 'answer', { acceptProposal: true, stage: 'review' });
    session = await act(service, session, 'confirm');
    assert.equal(session.requirements.teacherRequest, raw);
  }
});

test('old requirements and histories omit teacherRequest; empty request and exact text remain valid', async () => {
  const { config } = await getAssemblyConfig();
  const sourceIds = config.sources.map(source => source.sourceId);
  const normalize = teacherRequest => normalizeRequirements({ ...config.defaultRequirements, teacherRequest }, config, sourceIds);
  assert.equal(Object.hasOwn(normalize(undefined), 'teacherRequest'), false);
  assert.equal(normalize('').teacherRequest, '');
  assert.equal(normalize('  原话\n保留  ').teacherRequest, '  原话\n保留  ');
  assert.equal(normalize('字'.repeat(2000)).teacherRequest.length, 2000);
  for (const invalid of [null, 123, {}, '字'.repeat(2001)]) assert.throws(() => normalize(invalid), { code: 'invalid_plan' });

  const storage = createMemoryIntakeStorage();
  const service = createIntakeService({ storage, gateway });
  let session = (await service.handle({ action: 'start', flow: 'quick', operationId: operationId() })).session;
  session = await act(service, session, 'answer', { next: true });
  session = await act(service, session, 'confirm');
  assert.equal(Object.hasOwn((await service.get(session.sessionId)).session.requirements, 'teacherRequest'), false);
});

test('explicit natural-language type counts are pending until adopted, then fixed for planning', async () => {
  let context;
  const typedGateway = { async propose(input, { validate }) {
    context = input;
    return { ok: true, proposal: validate({ summary: '4道单选题，题干简洁、少复杂运算。', changes: {
      questionCount: 4, singleChoiceCount: 4, fillBlankCount: 0, freeResponseCount: 0,
      targetScore: 40, durationMinutes: 20,
    }, blocks: [] }), run: { status: 'succeeded' } };
  } };
  const service = createIntakeService({ gateway: typedGateway });
  let session = (await service.handle({ action: 'start', flow: 'quick', operationId: operationId() })).session;
  session = await act(service, session, 'prepare', { message: '4道单选题，40分20分钟，优先题干简洁少运算。' });
  assert.ok(context.supportedFields.includes('singleChoiceCount'));
  assert.equal(session.answers.questionCount, 10);
  assert.equal(session.planning.countPolicy, 'suggested');
  assert.equal(session.proposal.changes.singleChoiceCount, 4);
  session = await act(service, session, 'answer', { acceptProposal: true });
  session = await act(service, session, 'confirm');
  assert.equal(session.planning.countPolicy, 'fixed');
  assert.equal(session.answers.size, 'custom');
  assert.deepEqual(session.requirements.counts, { single_choice: 4, fill_blank: 0, free_response: 0 });
  assert.equal(session.requirements.targetScore, 40);
  assert.equal(session.requirements.durationMinutes, 20);
  assert.match(session.requirements.teacherRequest, /题干简洁少运算/);
});

test('incomplete, inconsistent or manually overridden natural-language type counts cannot become proposals', async () => {
  const cases = [
    { answers: {}, changes: { singleChoiceCount: 4 } },
    { answers: {}, changes: { questionCount: 5, singleChoiceCount: 4, fillBlankCount: 0, freeResponseCount: 0 } },
    { answers: { questionCount: 6 }, lockedFields: ['questionCount'], changes: { singleChoiceCount: 4, fillBlankCount: 0, freeResponseCount: 0 } },
    { answers: { size: 'custom', singleChoiceCount: 2, fillBlankCount: 1, freeResponseCount: 1 }, changes: { singleChoiceCount: 4, fillBlankCount: 0, freeResponseCount: 0 } },
    { answers: { size: 'preset' }, changes: { singleChoiceCount: 4, fillBlankCount: 0, freeResponseCount: 0 } },
  ];
  for (const item of cases) {
    let context;
    const service = createIntakeService({ gateway: { async propose(input, { validate }) {
      context = input;
      return { ok: true, proposal: validate({ summary: '按原话提出题型数量。', changes: item.changes, blocks: [] }), run: { status: 'succeeded' } };
    } } });
    let session = (await service.handle({ action: 'start', flow: 'quick', answers: item.answers, operationId: operationId() })).session;
    const before = structuredClone(session.answers);
    session = await act(service, session, 'prepare', { message: '4道单选题', lockedFields: item.lockedFields || [] });
    assert.equal(session.proposal, null, JSON.stringify(item));
    assert.ok(session.assistantError);
    assert.deepEqual(session.answers, before);
    if (before.size !== 'recommend') assert.equal(context.supportedFields.includes('singleChoiceCount'), false);
  }
});

test('later teacher wording can replace adopted model counts after confirmation and revise without changing the original', async () => {
  const contexts = [];
  const storage = createMemoryIntakeStorage();
  const service = createIntakeService({ storage, gateway: { async propose(context, { validate }) {
    contexts.push(context);
    const updated = context.message.includes('改成6道填空');
    return { ok: true, proposal: validate({ summary: updated ? '改为六道填空，待确认。' : '四道单选，待确认。', changes: updated
      ? { questionCount: 6, singleChoiceCount: 0, fillBlankCount: 6, freeResponseCount: 0 }
      : { questionCount: 4, singleChoiceCount: 4, fillBlankCount: 0, freeResponseCount: 0 }, blocks: [] }), run: { status: 'succeeded' } };
  } } });
  let session = (await service.handle({ action: 'start', flow: 'quick', operationId: operationId() })).session;
  session = await act(service, session, 'prepare', { message: '出4道单选，少复杂运算。' });
  session = await act(service, session, 'answer', { acceptProposal: true });
  assert.equal(session.quickTypeCountSource, 'model');
  session = await act(service, session, 'confirm');
  const original = session;
  session = (await service.handle({ action: 'revise', sessionId: session.sessionId, revision: session.revision, operationId: operationId() })).session;
  assert.equal(session.quickTypeCountSource, 'model');
  const later = '出4道单选，少复杂运算。\n补充需求：改成6道填空';
  session = await act(service, session, 'prepare', { message: later });
  assert.equal(contexts.at(-1).typeCountSource, 'model');
  assert.equal(contexts.at(-1).typeCountsEditable, true);
  assert.equal(contexts.at(-1).lockedFields.includes('questionCount'), false);
  assert.equal(contexts.at(-1).supportedFields.includes('fillBlankCount'), true);
  assert.deepEqual(session.requirements.counts, { single_choice: 4, fill_blank: 0, free_response: 0 });
  assert.equal(session.proposal.changes.questionCount, 6);
  assert.equal(session.proposal.changes.fillBlankCount, 6);
  assert.equal(session.planning.countPolicy, 'fixed');
  session = await act(service, session, 'answer', { acceptProposal: true });
  session = await act(service, session, 'confirm');
  assert.deepEqual(session.requirements.counts, { single_choice: 0, fill_blank: 6, free_response: 0 });
  assert.equal(session.quickTypeCountSource, 'model');
  assert.equal((await service.get(session.sessionId)).session.quickTypeCountSource, 'model');
  assert.deepEqual((await service.get(original.sessionId)).session.requirements.counts, { single_choice: 4, fill_blank: 0, free_response: 0 });
});

test('manual type editing after model adoption protects the ratio, including an explicitly resubmitted unchanged value', async () => {
  let context;
  const service = createIntakeService({ gateway: { async propose(input, { validate }) {
    context = input;
    const changes = input.message.includes('6道填空')
      ? { questionCount: 6, singleChoiceCount: 0, fillBlankCount: 6, freeResponseCount: 0 }
      : { questionCount: 4, singleChoiceCount: 4, fillBlankCount: 0, freeResponseCount: 0 };
    return { ok: true, proposal: validate({ summary: '题型建议，待确认。', changes, blocks: [] }), run: { status: 'succeeded' } };
  } } });
  let session = (await service.handle({ action: 'start', flow: 'quick', operationId: operationId() })).session;
  session = await act(service, session, 'prepare', { message: '4道单选' });
  session = await act(service, session, 'answer', { acceptProposal: true });
  session = await act(service, session, 'answer', { answers: { singleChoiceCount: 4 } });
  assert.equal(session.quickTypeCountSource, 'manual');
  session = await act(service, session, 'prepare', { message: '补充需求：6道填空' });
  assert.equal(context.typeCountsEditable, false);
  assert.equal(context.supportedFields.includes('fillBlankCount'), false);
  assert.ok(context.lockedFields.includes('questionCount'));
  assert.equal(session.proposal, null);
  assert.deepEqual(session.requirements.counts, { single_choice: 4, fill_blank: 0, free_response: 0 });
});

test('manual quantity lock still rejects a later model count change even when the adopted ratio remains model editable', async () => {
  let context;
  const service = createIntakeService({ gateway: { async propose(input, { validate }) {
    context = input;
    const changes = input.message.includes('6道填空')
      ? { questionCount: 6, singleChoiceCount: 0, fillBlankCount: 6, freeResponseCount: 0 }
      : { questionCount: 4, singleChoiceCount: 4, fillBlankCount: 0, freeResponseCount: 0 };
    return { ok: true, proposal: validate({ summary: '建议配比。', changes, blocks: [] }), run: { status: 'succeeded' } };
  } } });
  let session = (await service.handle({ action: 'start', flow: 'quick', operationId: operationId() })).session;
  session = await act(service, session, 'prepare', { message: '4道单选' });
  session = await act(service, session, 'answer', { acceptProposal: true });
  session = await act(service, session, 'prepare', { message: '改成6道填空', lockedFields: ['questionCount'] });
  assert.equal(context.typeCountsEditable, true);
  assert.equal(context.supportedFields.includes('questionCount'), false);
  assert.ok(context.lockedFields.includes('questionCount'));
  assert.equal(session.proposal, null);
  assert.equal(session.answers.questionCount, 4);
});

test('a changed total cannot silently disappear behind an earlier extracted fixed ratio', async () => {
  const service = createIntakeService({ gateway: { async propose(input, { validate }) {
    return { ok: true, proposal: validate({ summary: '题量建议。', changes: input.message.includes('改成6题')
      ? { questionCount: 6 }
      : { questionCount: 4, singleChoiceCount: 4, fillBlankCount: 0, freeResponseCount: 0 }, blocks: [] }), run: { status: 'succeeded' } };
  } } });
  let session = (await service.handle({ action: 'start', flow: 'quick', operationId: operationId() })).session;
  session = await act(service, session, 'prepare', { message: '4道单选' });
  session = await act(service, session, 'answer', { acceptProposal: true });
  session = await act(service, session, 'prepare', { message: '补充需求：改成6题' });
  assert.equal(session.proposal, null);
  assert.match(session.assistantError?.message || '', /未通过|失败/);
  assert.equal(session.answers.questionCount, 4);
});
