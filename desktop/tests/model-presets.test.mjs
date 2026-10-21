import test from 'node:test';
import assert from 'node:assert/strict';
import { deepseekPreset, modelProvider, newModelProfile, modelProfilePayload } from '../src/model-presets.ts';

test('DeepSeek preset uses an official endpoint and the supported model IDs', () => {
  const first = newModelProfile('simulated-first');
  const second = newModelProfile('simulated-second');
  assert.equal(first.provider, 'deepseek');
  assert.equal(first.baseUrl, 'https://api.deepseek.com');
  assert.deepEqual(deepseekPreset.models.map(model => model.id), ['deepseek-flash', 'deepseek-v4-pro']);
  first.apiKey = 'simulated-key';
  assert.equal(second.apiKey, '');
  const payload = modelProfilePayload({...first, baseUrl: 'https://untrusted.example'});
  assert.equal(payload.provider, 'deepseek');
  assert.equal(payload.baseUrl, undefined);
  assert.equal(payload.apiKey, 'simulated-key');
});

test('provider inference cannot silently adopt a custom endpoint or overwrite its settings', () => {
  for (const base of ['https://api.deepseek.com', 'https://api.deepseek.com:443/v1/']) assert.equal(modelProvider(base), 'deepseek');
  for (const base of ['https://api.deepseek.com.attacker.example', 'http://api.deepseek.com', 'https://api.deepseek.com/other', 'https://user@api.deepseek.com', 'https://api.deepseek.com?proxy=1']) assert.equal(modelProvider(base), null);
  const legacy = {id:'old',name:'原配置',provider:null,baseUrl:'https://other.example/v1',model:'original-model',apiKey:''};
  assert.deepEqual(modelProfilePayload(legacy), {id:'old',name:'原配置',baseUrl:'https://other.example/v1',model:'original-model'});
  assert.equal(modelProfilePayload({...legacy,provider:'deepseek',model:'deepseek-v4-pro'}).apiKey, undefined);
});
