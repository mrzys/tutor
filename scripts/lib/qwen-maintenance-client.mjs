// Explicit offline maintenance only. The desktop application calls models in Rust.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { decryptWindows } from './deepseek-maintenance-client.mjs';

const BASE_URL = 'https://maas.qianwenaiapi.com/compatible-mode/v1';
const MODEL = 'qwen3.8-flash';
const SAFE_ERROR = Symbol('maintenanceSafeError');

function failure(code, safeRecord = {}) {
  const error = new Error(code);
  error.code = code;
  error.safeRecord = safeRecord;
  error[SAFE_ERROR] = true;
  return error;
}


function stripReasoning(value) {
  let reasoningCharacters = 0;
  let reasoningReported = false;
  const walk = item => {
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') {
      const result = {};
      for (const [key, child] of Object.entries(item)) {
        if (key === 'reasoning_content') {
          if (typeof child === 'string' && child.length) {
            reasoningReported = true;
            reasoningCharacters += Array.from(child).length;
          }
        } else result[key] = walk(child);
      }
      return result;
    }
    return item;
  };
  const result = walk(value);
  return { ...result, reasoningReported, reasoningCharacters };
}

/** Independent, explicit offline review credentials. Never changes desktop settings. */
export async function openQwenMaintenanceClient({ settingsFile, agentEnvFile = path.join(os.homedir(), '.agent.env'),
  fetchImpl = globalThis.fetch, decryptImpl = decryptWindows, timeoutMs = 300_000 } = {}) {
  if (typeof settingsFile !== 'string' || typeof agentEnvFile !== 'string' || typeof fetchImpl !== 'function'
    || typeof decryptImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw failure('invalid_options');
  let settings;
  try { settings = JSON.parse(await readFile(settingsFile, 'utf8')); }
  catch { throw failure('settings_unreadable'); }
  if (settings?.schemaVersion !== 2 || !Array.isArray(settings.profiles)) throw failure('settings_invalid');
  const ids = settings.profiles.map(profile => profile?.id);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw failure('settings_invalid');
  const matches = settings.profiles.filter(profile => typeof profile?.baseUrl === 'string'
    && profile.baseUrl.replace(/\/$/, '') === BASE_URL && profile.model === MODEL && profile.reasoningEffort === 'on');
  const activeMatches = matches.filter(profile => profile.id === settings.activeProfileId);
  if (activeMatches.length !== 1 && matches.length > 1) throw failure('profile_ambiguous');
  const profile = activeMatches[0] ?? matches[0];
  let apiKey;
  if (profile) {
    if (typeof profile.protectedKey !== 'string' || !profile.protectedKey.length || profile.protectedKey.length > 32_768) throw failure('credential_unavailable');
    try { apiKey = await decryptImpl(profile.protectedKey); }
    catch (error) { throw failure(error?.code === 'unsupported_platform' ? 'unsupported_platform' : 'credential_decryption_failed'); }
  } else {
    // Literal dotenv values only: never execute/shell-expand the user's file or use another provider's key.
    let envText;
    try { envText = await readFile(agentEnvFile, 'utf8'); } catch { throw failure('qwen_credential_unavailable'); }
    const values = envText.split(/\r?\n/u).filter(line => /^\s*(?:export\s+)?QWEN_API_KEY\s*=/u.test(line));
    if (values.length !== 1) throw failure('qwen_credential_unavailable');
    let value = values[0].replace(/^\s*(?:export\s+)?QWEN_API_KEY\s*=\s*/u, '').trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0], end = value.indexOf(quote, 1);
      if (end < 0 || !/^\s*(?:#.*)?$/u.test(value.slice(end + 1))) throw failure('qwen_credential_unavailable');
      value = value.slice(1, end);
    } else value = value.replace(/\s+#.*$/u, '').trim();
    apiKey = value;
  }
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n\x00-\x1f\x7f]/u.test(apiKey)) throw failure('credential_unavailable');
  apiKey = apiKey.trim();
  const publicProfile = Object.freeze({ id: profile?.id ?? 'offline-qwen-agent-env', provider: 'qianwenai',
    baseUrl: BASE_URL, model: MODEL, reasoningEffort: 'on', enableThinking: true,
    credentialSource: profile ? 'saved_matching_profile' : 'explicit_offline_agent_env',
    selectedProfileWasActive: Boolean(profile && profile.id === settings.activeProfileId) });

  async function invoke(path, request) {
    const endpoint = BASE_URL + path;
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const controller = new AbortController();
    let timer;
    const safeRecord = () => ({ endpoint, startedAt, elapsedSeconds: (performance.now() - started) / 1000 });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(failure('request_timeout', safeRecord())); }, timeoutMs);
    });
    try {
      const operation = async () => {
        const response = await fetchImpl(endpoint, {
          method: request ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${apiKey}`, ...(request ? { 'Content-Type': 'application/json' } : {}) },
          ...(request ? { body: JSON.stringify(request) } : {}),
        });
        if (!response.ok) {
          // Never read or publish a provider error body: it can echo input or credentials.
          throw failure('http_error', { ...safeRecord(), status: Number.isInteger(response.status) ? response.status : null });
        }
        let data;
        try { data = await response.json(); }
        catch { throw failure('response_invalid_json', safeRecord()); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('response_invalid_shape', safeRecord());
        return data;
      };
      const data = await Promise.race([operation(), timeout]);
      return { data, ...safeRecord() };
    } catch (error) {
      if (error?.[SAFE_ERROR]) throw error;
      throw failure(controller.signal.aborted ? 'request_timeout' : 'request_failed', safeRecord());
    } finally { clearTimeout(timer); }
  }

  return {
    publicProfile,
    async getModels() {
      const { data, endpoint } = await invoke('/models');
      if (!Array.isArray(data.data) || data.data.some(item => typeof item?.id !== 'string' || !item.id)) {
        throw failure('model_list_invalid', { endpoint });
      }
      return { models: [...new Set(data.data.map(item => item.id))], endpoint, fetchedAt: new Date().toISOString() };
    },
    async complete(messages, { maxTokens = 32_768, onRequest } = {}) {
      if (!Array.isArray(messages) || !messages.length || !Number.isSafeInteger(maxTokens) || maxTokens <= 0
        || (onRequest !== undefined && typeof onRequest !== 'function')) {
        throw failure('invalid_request');
      }
      const request = { model: MODEL, messages: structuredClone(messages), enable_thinking: true, response_format: { type: 'json_object' }, max_tokens: maxTokens, stream: false };
      const requestSha256 = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      if (onRequest) {
        try { await onRequest(structuredClone(request)); }
        catch { throw failure('audit_write_failed'); }
      }
      const { data, elapsedSeconds, startedAt } = await invoke('/chat/completions', request);
      const providerResponse = stripReasoning(data);
      const content = providerResponse.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw failure('content_missing', { startedAt, elapsedSeconds });
      return { request, providerResponse, content, requestSha256, elapsedSeconds, startedAt };
    },
  };
}
