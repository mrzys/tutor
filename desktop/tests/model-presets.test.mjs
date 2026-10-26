import test from 'node:test';
import assert from 'node:assert/strict';
import { blankModelProfile, changeModelProvider, changeProfileModel, createModelCatalogGuard, deepseekPreset, llmProviders, modelProfileError, modelProvider, modelReasoningOptions, newModelProfile, modelProfilePayload, parseModelCatalog, reasoningLabel } from '../src/model-presets.ts';

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

test('模拟回归：四家服务商目录固定地址，空能力元数据不虚构模型，独立配置不继承密钥', () => {
  assert.deepEqual(llmProviders.map(provider => provider.id), ['deepseek', 'bailian', 'xiaomi', 'qianwenai']);
  for (const provider of llmProviders) {
    const first = newModelProfile(`simulated-${provider.id}`, provider.id);
    const second = newModelProfile(`simulated-${provider.id}-second`, provider.id);
    assert.equal(first.baseUrl, provider.baseUrl);
    assert.equal(first.model, provider.models[0]?.id || '');
    assert.equal(provider.modelsPath, '/models');
    assert.equal(modelProvider(provider.baseUrl), provider.id);
    first.apiKey = 'simulated-private-key';
    assert.equal(second.apiKey, '');
    assert.equal(second.hasApiKey, false);
    const payload = modelProfilePayload({ ...first, baseUrl: 'https://untrusted.example' });
    assert.equal(payload.provider, provider.id);
    assert.equal(payload.baseUrl, undefined);
    const url = new URL(provider.baseUrl);
    for (const unsafe of [`http://${url.host}${url.pathname}`, `${provider.baseUrl}?proxy=1`, `https://${url.hostname}.attacker.example${url.pathname}`, `https://user@${url.host}${url.pathname}`, `${provider.baseUrl}/other`]) assert.equal(modelProvider(unsafe), null);
  }
});

test('模拟回归：切换服务商清除草稿密钥与保存标记，切回也不能沿用旧密钥', () => {
  const original = { ...newModelProfile('simulated-switch'), name: '我的课堂模型', apiKey: 'simulated-entered-key', hasApiKey: true, configured: true };
  const snapshot = structuredClone(original);
  const bailian = changeModelProvider(original, 'bailian');
  assert.equal(bailian.name, original.name);
  assert.equal(bailian.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(bailian.apiKey, '');
  assert.equal(bailian.hasApiKey, false);
  assert.equal(bailian.configured, false);
  assert.equal(bailian.requiresApiKey, true);
  const back = changeModelProvider(bailian, 'deepseek');
  assert.equal(back.apiKey, '');
  assert.equal(back.hasApiKey, false);
  assert.equal(back.requiresApiKey, true);
  assert.deepEqual(original, snapshot);
  const xiaomi = changeModelProvider(newModelProfile('simulated-default-name'), 'xiaomi');
  assert.equal(xiaomi.name, '');
  assert.equal(xiaomi.model, '');
  assert.equal(xiaomi.reasoningEffort, undefined);
  assert.equal(changeModelProvider(xiaomi, 'xiaomi'), xiaomi);
});

test('provider inference cannot silently adopt a custom endpoint or overwrite its settings', () => {
  for (const base of ['https://api.deepseek.com', 'https://api.deepseek.com:443/v1/']) assert.equal(modelProvider(base), 'deepseek');
  for (const base of ['https://api.deepseek.com.attacker.example', 'http://api.deepseek.com', 'https://api.deepseek.com/other', 'https://user@api.deepseek.com', 'https://api.deepseek.com?proxy=1']) assert.equal(modelProvider(base), null);
  const legacy = {id:'old',name:'原配置',provider:null,baseUrl:'https://other.example/v1',model:'original-model',apiKey:''};
  assert.deepEqual(modelProfilePayload(legacy), {id:'old',name:'原配置',baseUrl:'https://other.example/v1',model:'original-model'});
  assert.equal(modelProfilePayload({...legacy,provider:'deepseek',model:'deepseek-v4-pro'}).apiKey, undefined);
});

test('模拟回归：思考设置随模型能力保存，旧配置缺项不被自动改写', () => {
  for (const provider of llmProviders) {
    const fresh = newModelProfile(`simulated-reasoning-${provider.id}`, provider.id);
    if (!provider.models.length) {
      assert.equal(fresh.reasoningEffort, undefined);
      assert.equal(fresh.model, '');
      continue;
    }
    assert.equal(fresh.reasoningEffort, 'off');
    assert.equal(modelProfilePayload(fresh).reasoningEffort, 'off');
    assert.ok(modelReasoningOptions(provider.id, fresh.model).some(option => option.id === 'off' && !option.disabled));
  }
  const original = { ...newModelProfile('simulated-reasoning-legacy'), reasoningEffort: undefined };
  assert.equal(modelProfilePayload(original).reasoningEffort, undefined);
  assert.equal(Object.hasOwn(modelProfilePayload(original), 'reasoningEffort'), false);
  assert.equal(reasoningLabel(original), '沿用原设置');
  const custom = { ...original, name: '教师保留的配置名称', reasoningEffort: 'max' };
  const deepseek = changeProfileModel(custom, 'deepseek-v4-pro');
  assert.equal(deepseek.reasoningEffort, 'max');
  assert.equal(deepseek.name, custom.name);
  assert.equal(changeModelProvider(deepseek, 'xiaomi').reasoningEffort, undefined);
  const qwen = { ...newModelProfile('simulated-qwen-reasoning', 'bailian'), model: 'qwen3.8-max', reasoningEffort: 'xhigh' };
  assert.equal(changeProfileModel(qwen, 'qwen-plus').reasoningEffort, 'off');
  assert.deepEqual(modelReasoningOptions('xiaomi', 'mimo-v2.6-pro').map(option => option.id), ['off', 'on']);
  assert.deepEqual(modelReasoningOptions('deepseek', 'unknown-legacy-alias'), []);
});

test('模拟回归：新增从空白独立草稿开始，明确选择厂商和模型才可完成', () => {
  const fresh = blankModelProfile('simulated-blank');
  const snapshot = structuredClone(fresh);
  assert.equal(fresh.provider, null);
  assert.equal(fresh.model, '');
  assert.equal(fresh.reasoningEffort, undefined);
  assert.equal(modelProfileError(fresh), '请选择服务商。');
  const provider = changeModelProvider(fresh, 'bailian');
  assert.equal(provider.model, '');
  assert.equal(provider.name, '');
  assert.equal(provider.apiKey, '');
  assert.equal(modelProfileError(provider), '请选择模型。');
  const model = changeProfileModel(provider, 'qwen3.8-max');
  assert.equal(model.reasoningEffort, 'off');
  assert.equal(modelProfileError(model), '请获取此服务商的模型列表后选择模型。');
  const catalog = parseModelCatalog({ provider: 'bailian', baseUrl: provider.baseUrl, models: [{ id: model.model, label: model.model }], catalogToken: 'simulated-token' }, 'bailian');
  assert.equal(modelProfileError({ ...model, catalogToken: catalog.catalogToken }, false, catalog), '请填写此服务商的 API Key。');
  assert.equal(modelProfileError({ ...model, apiKey: 'simulated-new-key', catalogToken: catalog.catalogToken }, false, catalog), '');
  assert.deepEqual(fresh, snapshot);
  const old = { ...newModelProfile('simulated-old'), model: 'old-alias', hasApiKey: true };
  assert.equal(modelProfileError(old, true), '');
  assert.equal(modelProfileError(old), '请获取此服务商的模型列表后选择模型。');
  assert.equal(modelProfileError({ ...old, provider: null, baseUrl: 'https://custom.example/v1' }, true), '');
});

test('模拟回归：千问平台必须使用自身真实目录，未知模型能力不继承百炼', () => {
  const item = changeModelProvider(blankModelProfile('simulated-qianwenai'), 'qianwenai');
  assert.equal(item.baseUrl, 'https://maas.qianwenaiapi.com/compatible-mode/v1');
  assert.equal(item.model, '');
  const result = { provider: 'qianwenai', baseUrl: item.baseUrl, catalogToken: 'simulated-qianwen-catalog', models: [{ id: 'provider-dialogue-id', label: 'provider-dialogue-id' }, { id: 'provider-image-id', label: 'provider-image-id' }] };
  const catalog = parseModelCatalog(result, 'qianwenai');
  assert.deepEqual(catalog.models.map(model => model.id), result.models.map(model => model.id));
  const selected = { ...changeProfileModel(item, catalog.models[0].id, catalog.models), apiKey: 'simulated-key', catalogToken: catalog.catalogToken };
  assert.equal(selected.reasoningEffort, undefined);
  assert.equal(modelProfileError(selected, false, catalog), '');
  assert.equal(modelProfilePayload(selected).catalogToken, catalog.catalogToken);
  assert.equal(Object.hasOwn(modelProfilePayload(selected, false), 'catalogToken'), false);
  assert.notEqual(modelProfileError({ ...selected, catalogToken: undefined }, false, catalog), '');
  assert.notEqual(modelProfileError({ ...selected, model: 'qwen-plus' }, false, catalog), '');
  assert.deepEqual(modelReasoningOptions('qianwenai', 'qwen-plus'), []);
  for (const invalid of [null, { ...result, provider: 'bailian' }, { ...result, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }, { ...result, catalogToken: '' }, { ...result, models: [] }, { ...result, models: [result.models[0], result.models[0]] }, { ...result, models: [{ id: '', label: '' }] }]) assert.throws(() => parseModelCatalog(invalid, 'qianwenai'));
});

test('模拟回归：目录显式提供的能力可用，未知能力不臆造，保留模型不改变原思考设置', () => {
  const original = { ...newModelProfile('simulated-capability'), reasoningEffort: 'high' };
  assert.equal(changeProfileModel(original, original.model, []).reasoningEffort, 'high');
  const unknown = changeProfileModel(original, 'new-provider-model', [{ id: 'new-provider-model', label: '新模型' }]);
  assert.equal(unknown.reasoningEffort, undefined);
  const explicit = changeProfileModel(original, 'new-provider-model', [{ id: 'new-provider-model', label: '新模型', reasoningOptions: [{ id: 'off', label: '关闭思考' }, { id: 'on', label: '开启思考' }] }]);
  assert.equal(explicit.reasoningEffort, 'off');
  const old = { ...original, provider: 'qianwenai', model: 'preserved-model' };
  assert.equal(modelProfileError(old, true), '');
});

test('模拟回归：百炼既有3.7 Flash配置无需重拉目录即可编辑思考，新选型号仍需真实目录', () => {
  for (const model of ['qwen3.7-flash', 'qwen3.7-flash-2026-07-15']) {
    assert.deepEqual(modelReasoningOptions('bailian', model).map(option => option.id), ['off', 'on']);
    const original = { ...newModelProfile('simulated-old-flash', 'bailian'), model, reasoningEffort: undefined };
    assert.equal(changeProfileModel(original, model, []).reasoningEffort, undefined);
    assert.equal(Object.hasOwn(modelProfilePayload(original), 'reasoningEffort'), false);
    assert.equal(modelProfileError(original, true), '');
    assert.notEqual(modelProfileError(original, false), '');
    for (const reasoningEffort of ['off', 'on']) {
      assert.equal(modelProfilePayload({ ...original, reasoningEffort }).reasoningEffort, reasoningEffort);
    }
    assert.deepEqual(modelReasoningOptions('qianwenai', model), []);
  }
  assert.deepEqual(modelReasoningOptions('bailian', 'qwen3.7-flash-unknown'), []);
});

test('模拟回归：千问平台仅已验证的 qwen3.8-flash 显示思考开关，能力元数据不能替代真实目录', () => {
  const options = modelReasoningOptions('qianwenai', 'qwen3.8-flash');
  assert.deepEqual(options.map(option => option.id), ['off', 'on']);
  assert.equal(options.some(option => ['low', 'medium', 'high', 'xhigh', 'max'].includes(option.id)), false);
  for (const model of ['qwen-plus', 'qwen3.8-max', 'qwen3.8-flash-unknown', 'mimo-v2.6-pro']) assert.deepEqual(modelReasoningOptions('qianwenai', model), []);

  const fresh = changeModelProvider(blankModelProfile('simulated-qianwen-thinking'), 'qianwenai');
  assert.equal(fresh.model, '');
  const flash = changeProfileModel(fresh, 'qwen3.8-flash');
  assert.equal(flash.reasoningEffort, 'off');
  assert.equal(modelProfileError({ ...flash, apiKey: 'simulated-key' }), '请获取此服务商的模型列表后选择模型。');
  for (const reasoningEffort of ['off', 'on']) {
    const configured = { ...flash, reasoningEffort };
    assert.equal(modelProfilePayload(configured).reasoningEffort, reasoningEffort);
    assert.equal(reasoningLabel(configured), reasoningEffort === 'on' ? '开启思考' : '关闭思考');
    assert.equal(changeProfileModel(configured, 'qwen-plus').reasoningEffort, undefined);
    assert.equal(changeModelProvider(configured, 'deepseek').reasoningEffort, undefined);
    assert.equal(changeModelProvider(configured, 'bailian').reasoningEffort, undefined);
  }
  const incompatible = { ...fresh, model: 'previous-model', reasoningEffort: 'high' };
  assert.equal(changeProfileModel(incompatible, 'qwen3.8-flash').reasoningEffort, 'off');
  const old = { ...flash, reasoningEffort: undefined };
  assert.equal(Object.hasOwn(modelProfilePayload(old), 'reasoningEffort'), false);
  assert.equal(changeProfileModel(old, old.model).reasoningEffort, undefined);
  assert.equal(reasoningLabel(old), '沿用原设置');
});

test('模拟回归：切换密钥、服务商、取消或重新打开编辑器后拒绝旧目录异步响应', async () => {
  const guard = createModelCatalogGuard();
  for (const boundary of ['key', 'provider', 'cancel', 'reopen']) {
    const request = guard.begin();
    guard.invalidate();
    await Promise.resolve();
    assert.equal(guard.isCurrent(request), false, boundary);
  }
  const first = guard.begin();
  const second = guard.begin();
  assert.equal(guard.isCurrent(first), false);
  assert.equal(guard.isCurrent(second), true);
});
