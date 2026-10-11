import test from 'node:test';
import assert from 'node:assert/strict';
import { draftSupplyKey, slotSupply, supplyPresentation, validateCandidateSupply } from '../web/question-supply.js';

const draft = { draftId: 'test-draft', revision: 2, slots: [{ slotId: 's1' }, { slotId: 's2' }] };
const response = { revision: 2, slots: [
  { slotId: 's1', eligibleCount: 3, suggestionCount: 4, readFailureCount: 0 },
  { slotId: 's2', eligibleCount: 0, suggestionCount: 1, readFailureCount: 0 },
] };

test('supply presentation uses only a complete matching revision batch', () => {
  const rows = validateCandidateSupply(response, draft);
  const state = { key: draftSupplyKey(draft), loading: false, error: '', rows };
  assert.equal(supplyPresentation(slotSupply(state, draft, 's1')).label, '3 道备选');
  assert.equal(supplyPresentation(slotSupply(state, draft, 's2')).exhausted, true);
  assert.deepEqual(slotSupply(state, { ...draft, revision: 3 }, 's1'), { loading: true, error: '', data: null });
  assert.deepEqual(slotSupply(state, { ...draft, draftId: 'another' }, 's1'), { loading: true, error: '', data: null });
});

test('missing, duplicate, invalid or stale counts cannot become zero supply', () => {
  for (const invalid of [
    { ...response, revision: 1 }, { ...response, slots: response.slots.slice(1) },
    { ...response, slots: [response.slots[0], response.slots[0]] },
    { ...response, slots: [response.slots[0], { ...response.slots[1], readFailureCount: undefined }] },
    { ...response, slots: [response.slots[0], { ...response.slots[1], eligibleCount: -1 }] },
  ]) assert.throws(() => validateCandidateSupply(invalid, draft));
  assert.equal(supplyPresentation({ loading: false, error: '断网', data: null }).exhausted, false);
  assert.equal(supplyPresentation({ loading: false, data: null }).exhausted, false);
});

test('zero verified candidates plus read failures are incomplete rather than exhausted', () => {
  const presentation = supplyPresentation({ loading: false, data: { eligibleCount: 0, readFailureCount: 2 } });
  assert.equal(presentation.exhausted, false);
  assert.match(presentation.label, /2 道读取失败/);
  assert.match(presentation.detail, /余量可能不完整/);
});
