import test from 'node:test';
import assert from 'node:assert/strict';
import { accuracyRequiredRoles } from '../src/import-accuracy.ts';
import { uploadModelDestinations, uploadOcrDestination } from '../src/import-upload.ts';

test('simulated send notice discloses processing and review profiles, never the general profile or credentials', () => {
  const model = { activeProfileId: 'other', importRoles: Object.fromEntries(accuracyRequiredRoles.map(([key]) => [key, 'saved'])),
    profiles: [{ id: 'saved', name: '模拟已保存', provider: 'custom', model: 'simulated-model', baseUrl: 'https://user:password@models.example/v1?secret=x', apiKey: 'must-not-render' }, { id: 'other', name: '不应显示' }] };
  const result = uploadModelDestinations(model);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(row => row.role), ['处理模型', '复核模型']);
  assert.ok(result.every(row => row.configuration === '模拟已保存' && row.service === 'models.example · simulated-model'));
  assert.doesNotMatch(JSON.stringify(result), /password|secret|must-not-render|不应显示/);
  model.importRoles.sourceParsing = 'missing';
  assert.equal(uploadModelDestinations(model)[0].configuration, '未配置');
});
test('simulated OCR destination discloses service and model without endpoint credentials or query strings', () => {
  assert.equal(uploadOcrDestination({ configured: true, model: 'simulated-ocr', baseUrl: 'https://user:password@ocr.example/jobs?token=private' }), 'PaddleOCR · simulated-ocr · ocr.example');
  assert.equal(uploadOcrDestination({ configured: false }), '尚未配置');
});
