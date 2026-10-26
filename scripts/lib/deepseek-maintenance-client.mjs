// Explicit offline maintenance only. The desktop application calls models in Rust.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const BASE_URL = 'https://api.deepseek.com';
const MODEL = 'deepseek-flash';
const SAFE_ERROR = Symbol('maintenanceSafeError');
const DECRYPT_COMMAND = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $cipher = [Convert]::FromBase64String([Console]::In.ReadToEnd())
  $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain))
  [Array]::Clear($plain, 0, $plain.Length)
} catch { exit 1 }
`;

function failure(code, safeRecord = {}) {
  const error = new Error(code);
  error.code = code;
  error.safeRecord = safeRecord;
  error[SAFE_ERROR] = true;
  return error;
}

export function decryptWindows(protectedKey) {
  if (process.platform !== 'win32') throw failure('unsupported_platform');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', DECRYPT_COMMAND], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(failure('credential_decryption_failed'));
    }, 30_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      output += data;
      if (output.length > 65_536) {
        output = '';
        child.kill();
        finish(failure('credential_decryption_failed'));
      }
    });
    child.on('error', () => finish(failure('credential_decryption_failed')));
    child.stdin.on('error', () => finish(failure('credential_decryption_failed')));
    child.on('close', code => finish(code === 0 ? null : failure('credential_decryption_failed'), output));
    // Ciphertext travels through stdin; neither ciphertext nor plaintext is an argument or env value.
    child.stdin.end(protectedKey);
  });
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

export async function openDeepSeekMaintenanceClient({ settingsFile, fetchImpl = globalThis.fetch,
  decryptImpl = decryptWindows, timeoutMs = 300_000 } = {}) {
  if (typeof settingsFile !== 'string' || typeof fetchImpl !== 'function'
    || typeof decryptImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw failure('invalid_options');
  }
  let settings;
  try { settings = JSON.parse(await readFile(settingsFile, 'utf8')); }
  catch { throw failure('settings_unreadable'); }
  if (settings?.schemaVersion !== 2 || !Array.isArray(settings.profiles)) throw failure('settings_invalid');
  const ids = settings.profiles.map(profile => profile?.id);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw failure('settings_invalid');
  const matches = settings.profiles.filter(profile => profile && typeof profile.id === 'string'
    && profile.id.length > 0 && typeof profile.baseUrl === 'string' && profile.baseUrl.replace(/\/$/, '') === BASE_URL
    && profile.model === MODEL && profile.reasoningEffort === 'high');
  const activeMatches = matches.filter(profile => profile.id === settings.activeProfileId);
  const profile = activeMatches.length === 1 ? activeMatches[0] : matches.length === 1 ? matches[0] : null;
  if (!profile) throw failure(matches.length ? 'profile_ambiguous' : 'profile_not_found');
  if (typeof profile.protectedKey !== 'string' || !profile.protectedKey.length
    || profile.protectedKey.length > 32_768) throw failure('credential_unavailable');
  let apiKey;
  try { apiKey = await decryptImpl(profile.protectedKey); }
  catch (error) { throw failure(error?.code === 'unsupported_platform' ? 'unsupported_platform' : 'credential_decryption_failed'); }
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) throw failure('credential_unavailable');
  apiKey = apiKey.trim();
  const publicProfile = Object.freeze({ id: profile.id, baseUrl: BASE_URL, model: MODEL,
    reasoningEffort: 'high', selectedProfileWasActive: profile.id === settings.activeProfileId });

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
    async complete(messages, { maxTokens = 16_384, onRequest } = {}) {
      if (!Array.isArray(messages) || !messages.length || !Number.isSafeInteger(maxTokens) || maxTokens <= 0
        || (onRequest !== undefined && typeof onRequest !== 'function')) {
        throw failure('invalid_request');
      }
      const request = { model: MODEL, messages: structuredClone(messages), thinking: { type: 'enabled' },
        reasoning_effort: 'high', response_format: { type: 'json_object' }, max_tokens: maxTokens, stream: false };
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
