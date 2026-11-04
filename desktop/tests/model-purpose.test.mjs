import test from 'node:test';
import assert from 'node:assert/strict';
import { assignImportModel, assignImportRole, assignImportRoleThinking, assignProcessingThinking, emptyImportRoles, emptyImportRoleThinking, importModelDefinitions, importModelProfileId, importRoleChoices, importRoleDefinitions, importRoleThinkingChoices, profileImportRoles, pruneImportRoleThinking, readImportRoles, readImportRoleThinking } from '../src/model-purpose.ts';
const profiles = [{ id: 'sim-ds-low', name: '模拟拆题配置', provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'low' },
  { id: 'sim-qwen', name: '模拟复核配置', provider: 'qianwenai', model: 'qwen3.8-flash', reasoningEffort: 'on' }];
test('legacy absent/null stays one explicit mode; assigned empty roles are never fallback', () => {
  assert.equal(readImportRoles(undefined, profiles), null); assert.equal(readImportRoles(null, profiles), null);
  assert.deepEqual(readImportRoles(emptyImportRoles(), profiles), emptyImportRoles());
  assert.deepEqual(importRoleDefinitions.map(r => r.id), ['sourceParsing', 'teachingGeneration', 'teachingReview', 'sourceVerification', 'independentSolve', 'mathVerification', 'teachingVerification']);
});
test('same profile can serve multiple roles and one null leaves others intact without mutating saved draft', () => {
  const old = { sourceParsing: 'sim-ds-low', teachingGeneration: 'sim-ds-low', teachingReview: 'sim-qwen' }; const before = structuredClone(old);
  const next = assignImportRole(old, 'teachingReview', null, profiles);
  assert.deepEqual(next, { sourceParsing: 'sim-ds-low', teachingGeneration: 'sim-ds-low', teachingReview: null }); assert.deepEqual(old, before);
  assert.deepEqual(profileImportRoles(old, 'sim-ds-low'), ['拆题', '解析生成']); assert.deepEqual(profileImportRoles(null, 'sim-ds-low'), []);
  assert.deepEqual(profileImportRoles(next, null), []);
});
test('malformed, dangling, missing or extra role identities fail instead of silently resetting settings', () => {
  for (const input of [[], 'legacy', {}, { sourceParsing: null, teachingGeneration: null }, { ...emptyImportRoles(), additional: null }, { ...emptyImportRoles(), sourceParsing: '' }, { ...emptyImportRoles(), sourceParsing: 'missing' }, { ...emptyImportRoles(), teachingReview: 1 }]) assert.throws(() => readImportRoles(input, profiles));
  assert.throws(() => assignImportRole(null, 'sourceParsing', 'sim-ds-low', profiles));
});
test('completed unsaved named profiles can be bound in the same save batch, without creating or changing their thinking setting', () => {
  const fresh = { id: 'sim-unsaved', name: '本次新增', provider: 'qianwenai', model: 'qwen3.8-flash' };
  const items = [...profiles, fresh], before = structuredClone(items);
  const roles = assignImportRole(emptyImportRoles(), 'teachingGeneration', fresh.id, items);
  assert.equal(readImportRoles(roles, items).teachingGeneration, fresh.id); assert.throws(() => readImportRoles(roles, profiles));
  assert.deepEqual(items, before); assert(!Object.hasOwn(fresh, 'reasoningEffort'));
});
test('role choices expose named profile, service and exact model without conflating profile thinking with a purpose override', () => {
  const before = structuredClone(profiles), choices = importRoleChoices(profiles);
  assert.equal(choices[0].id, ''); assert.equal(choices[0].label, '未配置');
  assert.equal(choices[1].label, '模拟拆题配置'); assert(choices[1].detail.includes('deepseek-flash')); assert(!choices[1].detail.includes('低'));
  assert(choices[2].detail.includes('qwen3.8-flash')); assert(choices[2].detail.includes('千问'));
  assert.deepEqual(profiles, before); assert(!JSON.stringify(choices).includes('apiKey'));
});

const assignedRoles = { sourceParsing: 'sim-ds-low', teachingGeneration: 'sim-ds-low', teachingReview: 'sim-qwen' };
const binding = (effort, profile = profiles[0]) => ({ profileId: profile.id, provider: profile.provider, model: profile.model, reasoningEffort: effort });

test('simulated same-profile purposes set independent low/high thinking without changing profile preferences or other purposes', () => {
  const before = structuredClone(profiles), initial = emptyImportRoleThinking();
  const source = assignImportRoleThinking(initial, 'sourceParsing', 'low', assignedRoles, profiles);
  const generation = assignImportRoleThinking(source, 'teachingGeneration', 'high', assignedRoles, profiles);
  assert.deepEqual(generation, { ...emptyImportRoleThinking(), sourceParsing: binding('low'), teachingGeneration: binding('high') });
  assert.deepEqual(initial, emptyImportRoleThinking()); assert.deepEqual(source, { ...emptyImportRoleThinking(), sourceParsing: binding('low') });
  assert.deepEqual(profiles, before);
  const cleared = assignImportRoleThinking(generation, 'sourceParsing', '', assignedRoles, profiles);
  assert.deepEqual(cleared, { ...emptyImportRoleThinking(), teachingGeneration: binding('high') });
});

test('simulated missing and null purpose thinking inherit profile settings without turning on thinking', () => {
  assert.equal(readImportRoleThinking(undefined, assignedRoles, profiles), null);
  assert.equal(readImportRoleThinking(null, assignedRoles, profiles), null);
  assert.deepEqual(readImportRoleThinking(emptyImportRoleThinking(), assignedRoles, profiles), emptyImportRoleThinking());
  assert(importRoleThinkingChoices(profiles[0])[0].label.includes('低'));
  const unset = { ...profiles[0], reasoningEffort: undefined };
  assert(importRoleThinkingChoices(unset)[0].label.includes('沿用原设置'));
  assert.equal(readImportRoleThinking(null, null, profiles), null);
  assert.equal(assignImportRoleThinking(null, 'sourceParsing', '', null, profiles), null);
  assert.throws(() => assignImportRoleThinking(null, 'sourceParsing', 'low', null, profiles));
});

test('simulated malformed, unsupported, unbound or stale purpose thinking is rejected atomically', () => {
  const good = { ...emptyImportRoleThinking(), sourceParsing: binding('low') }, before = structuredClone(good);
  for (const value of [[], 'low', {}, { sourceParsing: null }, { ...emptyImportRoleThinking(), extra: null },
    { ...good, sourceParsing: undefined }, { ...good, sourceParsing: 'low' },
    { ...good, sourceParsing: { ...binding('low'), extra: true } },
    { ...good, sourceParsing: { ...binding('low'), provider: 'qianwenai' } },
    { ...good, sourceParsing: { ...binding('low'), profileId: 'missing' } },
    { ...good, sourceParsing: { ...binding('low'), model: 'unknown' } },
    { ...good, sourceParsing: { ...binding('low'), reasoningEffort: 'medium' } }]) assert.throws(() => readImportRoleThinking(value, assignedRoles, profiles));
  assert.throws(() => readImportRoleThinking(good, { ...assignedRoles, sourceParsing: null }, profiles));
  assert.throws(() => readImportRoleThinking(good, null, profiles));
  assert.throws(() => assignImportRoleThinking(good, 'sourceParsing', 'medium', assignedRoles, profiles));
  assert.deepEqual(good, before);
});

test('simulated Qwen offers only verified on/off, while unknown capability has only inheritance', () => {
  assert.deepEqual(importRoleThinkingChoices(profiles[1]).map(option => option.id), ['', 'off', 'on']);
  assert.deepEqual(assignImportRoleThinking(null, 'teachingReview', 'on', assignedRoles, profiles).teachingReview, binding('on', profiles[1]));
  assert.throws(() => assignImportRoleThinking(null, 'teachingReview', 'high', assignedRoles, profiles));
  const unknown = { ...profiles[1], model: 'qwen-future-unknown' }, withUnknown = [profiles[0], unknown];
  assert.deepEqual(importRoleThinkingChoices(unknown).map(option => option.id), ['']);
  assert.throws(() => assignImportRoleThinking(null, 'teachingReview', 'on', assignedRoles, withUnknown));
  assert.deepEqual(importRoleThinkingChoices().map(option => option.id), ['']);
});

test('simulated explicit model/provider/profile changes prune only invalid purpose overrides and legacy clears all', () => {
  const thinking = { sourceParsing: binding('low'), teachingGeneration: binding('high'), teachingReview: binding('on', profiles[1]) }, before = structuredClone(thinking);
  const changedModel = profiles.map(profile => profile.id === profiles[0].id ? { ...profile, model: 'deepseek-v4-pro' } : profile);
  assert.deepEqual(pruneImportRoleThinking(thinking, assignedRoles, changedModel), { sourceParsing: null, teachingGeneration: null, teachingReview: binding('on', profiles[1]) });
  const changedProvider = profiles.map(profile => profile.id === profiles[0].id ? { ...profile, provider: 'bailian' } : profile);
  assert.deepEqual(pruneImportRoleThinking(thinking, assignedRoles, changedProvider), { sourceParsing: null, teachingGeneration: null, teachingReview: binding('on', profiles[1]) });
  assert.deepEqual(pruneImportRoleThinking(thinking, { ...assignedRoles, sourceParsing: null }, profiles), { ...thinking, sourceParsing: null });
  const changedDefault = profiles.map(profile => ({ ...profile, reasoningEffort: 'off' }));
  assert.deepEqual(pruneImportRoleThinking(thinking, assignedRoles, changedDefault), thinking);
  assert.equal(pruneImportRoleThinking(thinking, null, profiles), null);
  assert.deepEqual(thinking, before);
});

test('old three-purpose reads preserve their shape without filling new verification bindings or rewriting input', () => {
  const oldRoles = { ...assignedRoles }, oldThinking = { sourceParsing: binding('low'), teachingGeneration: null, teachingReview: null };
  const before = JSON.stringify({ oldRoles, oldThinking });
  assert.deepEqual(readImportRoles(oldRoles, profiles), oldRoles);
  assert.deepEqual(readImportRoleThinking(oldThinking, oldRoles, profiles), oldThinking);
  assert.equal(JSON.stringify({ oldRoles, oldThinking }), before);
  for (const role of ['sourceVerification', 'independentSolve', 'mathVerification', 'teachingVerification']) {
    assert.equal(Object.hasOwn(readImportRoles(oldRoles, profiles), role), false);
    assert.equal(Object.hasOwn(readImportRoleThinking(oldThinking, oldRoles, profiles), role), false);
  }
});

test('four new purposes have exact profile-bound independent thinking and deletion references', () => {
  let roles = { ...assignedRoles }, thinking = null;
  const expected = ['来源核验', '独立求解', '数学核验', '教学核验'];
  const newRoles = ['sourceVerification', 'independentSolve', 'mathVerification', 'teachingVerification'];
  for (const [index, role] of newRoles.entries()) {
    roles = assignImportRole(roles, role, 'sim-ds-low', profiles);
    thinking = assignImportRoleThinking(thinking, role, index % 2 ? 'high' : 'low', roles, profiles);
  }
  assert.deepEqual(profileImportRoles(roles, 'sim-ds-low'), ['拆题', '解析生成', ...expected]);
  const actual = readImportRoleThinking(thinking, roles, profiles);
  for (const [index, role] of newRoles.entries()) assert.deepEqual(actual[role], binding(index % 2 ? 'high' : 'low'));
  assert.equal(actual.teachingReview, null);
  const nextRoles = assignImportRole(roles, 'mathVerification', 'sim-qwen', profiles);
  const pruned = pruneImportRoleThinking(actual, nextRoles, profiles);
  assert.equal(pruned.mathVerification, null);
  assert.deepEqual(pruned.sourceVerification, actual.sourceVerification);
  assert.throws(() => readImportRoleThinking(actual, nextRoles, profiles));
  assert.throws(() => readImportRoles({ ...roles, independentSolve: 'missing' }, profiles));
  assert.throws(() => assignImportRoleThinking(null, 'independentSolve', 'low', null, profiles));
});

test('two-model selection binds processing and transcription explicitly without changing historical verification or review', () => {
  const old = { ...assignedRoles, sourceParsing: profiles[1].id, sourceVerification: profiles[1].id, independentSolve: profiles[0].id }, before = structuredClone(old);
  assert.equal(importModelDefinitions.length, 2);
  assert.equal(importModelProfileId(old, 'teachingGeneration'), '');
  const next = assignImportModel(old, 'teachingGeneration', profiles[0].id, profiles);
  assert.equal(next.sourceParsing, profiles[0].id);
  assert.equal(next.teachingGeneration, profiles[0].id);
  assert.equal(importModelProfileId(next, 'teachingGeneration'), profiles[0].id);
  assert.equal(next.teachingReview, profiles[1].id);
  assert.equal(next.sourceVerification, old.sourceVerification);
  assert.equal(next.independentSolve, old.independentSolve);
  assert.deepEqual(old, before);
  const fromLegacy = assignImportModel(null, 'teachingGeneration', profiles[0].id, profiles);
  assert.equal(fromLegacy.teachingReview, null);
  assert.equal(fromLegacy.sourceVerification, null);
});

test('processing selection preserves valid transcription thinking and only clears stale overrides', () => {
  const roles = { ...emptyImportRoles(), sourceParsing: profiles[0].id, teachingGeneration: profiles[1].id, teachingReview: profiles[1].id };
  const thinking = { ...emptyImportRoleThinking(), sourceParsing: binding('low'), teachingGeneration: binding('on', profiles[1]), teachingReview: binding('on', profiles[1]) };
  const before = structuredClone({ roles, thinking });
  const nextRoles = assignImportModel(roles, 'teachingGeneration', profiles[0].id, profiles);
  const nextThinking = pruneImportRoleThinking(thinking, nextRoles, profiles);
  assert.deepEqual(nextThinking.sourceParsing, binding('low'));
  assert.equal(nextThinking.teachingGeneration, null);
  assert.deepEqual(nextThinking.teachingReview, binding('on', profiles[1]));
  assert.deepEqual({ roles, thinking }, before);
});

test('review selection and clearing leave processing intact and invalid model identities cannot be assigned', () => {
  const next = assignImportModel(assignedRoles, 'teachingReview', null, profiles);
  assert.deepEqual(next, { ...assignedRoles, teachingReview: null });
  assert.equal(importModelProfileId(next, 'teachingReview'), '');
  const cleared = assignImportModel(assignedRoles, 'teachingGeneration', null, profiles);
  assert.deepEqual(cleared, { ...assignedRoles, sourceParsing: null, teachingGeneration: null });
  assert.throws(() => assignImportModel(null, 'teachingGeneration', 'missing', profiles));
  assert.throws(() => assignImportModel(null, 'independentSolve', profiles[0].id, profiles));
});

test('explicit processing preset separates index low from splitting and solving high without migrating reads', () => {
  const old = { ...emptyImportRoleThinking(), sourceParsing: binding('low'), teachingReview: binding('on', profiles[1]) };
  const before = structuredClone(old);
  assert(!Object.hasOwn(readImportRoleThinking(old, assignedRoles, profiles), 'sourceIndexing'));
  const next = assignProcessingThinking(old, assignedRoles, profiles);
  assert.deepEqual(next.sourceIndexing, binding('low'));
  assert.deepEqual(next.sourceParsing, binding('high'));
  assert.deepEqual(next.teachingGeneration, binding('high'));
  assert.deepEqual(next.teachingReview, old.teachingReview);
  assert.deepEqual(old, before);
});

test('index thinking binds only to the splitting profile and stale index overrides are cleared', () => {
  const next = assignImportRoleThinking(null, 'sourceIndexing', 'low', assignedRoles, profiles);
  assert.deepEqual(next.sourceIndexing, binding('low'));
  assert.throws(() => readImportRoles({ ...assignedRoles, sourceIndexing: profiles[0].id }, profiles));
  assert.throws(() => readImportRoleThinking({ ...next, sourceIndexing: binding('on', profiles[1]) }, assignedRoles, profiles));
  assert.equal(pruneImportRoleThinking(next, { ...assignedRoles, sourceParsing: profiles[1].id }, profiles).sourceIndexing, null);
  assert.equal(pruneImportRoleThinking(next, { ...assignedRoles, sourceParsing: null }, profiles).sourceIndexing, null);
});

test('processing preset does not invent intensity levels for switch-only models or unknown capabilities', () => {
  const roles = { ...assignedRoles, sourceParsing: profiles[1].id, teachingGeneration: profiles[1].id };
  const old = { ...emptyImportRoleThinking(), sourceParsing: binding('on', profiles[1]) };
  assert.deepEqual(assignProcessingThinking(old, roles, profiles), old);
  const unknown = [{ ...profiles[0], model: 'simulated-unknown-model' }];
  assert.equal(assignProcessingThinking(null, { ...assignedRoles, teachingReview: null }, unknown), null);
});
