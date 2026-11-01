import test from 'node:test';
import assert from 'node:assert/strict';
import { assignImportRole, assignImportRoleThinking, emptyImportRoles, emptyImportRoleThinking, importRoleChoices, importRoleDefinitions, importRoleThinkingChoices, profileImportRoles, pruneImportRoleThinking, readImportRoles, readImportRoleThinking } from '../src/model-purpose.ts';
const profiles = [{ id: 'sim-ds-low', name: '模拟拆题配置', provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'low' },
  { id: 'sim-qwen', name: '模拟复核配置', provider: 'qianwenai', model: 'qwen3.8-flash', reasoningEffort: 'on' }];
test('legacy absent/null stays one explicit mode; assigned empty roles are never fallback', () => {
  assert.equal(readImportRoles(undefined, profiles), null); assert.equal(readImportRoles(null, profiles), null);
  assert.deepEqual(readImportRoles(emptyImportRoles(), profiles), { sourceParsing: null, teachingGeneration: null, teachingReview: null });
  assert.deepEqual(importRoleDefinitions.map(r => r.id), ['sourceParsing', 'teachingGeneration', 'teachingReview']);
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
  assert.deepEqual(generation, { sourceParsing: binding('low'), teachingGeneration: binding('high'), teachingReview: null });
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
