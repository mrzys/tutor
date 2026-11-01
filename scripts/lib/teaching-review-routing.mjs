// Lazy cross-provider review selection, shared only by explicit offline maintenance.
import { openQwenMaintenanceClient } from './qwen-maintenance-client.mjs';
export const plannedReviewProfile = Object.freeze({ provider: 'qianwenai',
  baseUrl: 'https://maas.qianwenaiapi.com/compatible-mode/v1', model: 'qwen3.8-flash', reasoningEffort: 'on', enableThinking: true });
export function createMaintenanceReviewRouting({ settingsFile, agentEnvFile, reviewClientFactory = openQwenMaintenanceClient, save }) {
  let pending;
  let profile = null;
  return {
    get modelListRequests() { return 0; },
    get profile() { return profile; },
    getClient() {
      // Retain a rejected credential-selection promise too; never retry or change providers implicitly.
      return pending ??= (async () => {
        const client = await reviewClientFactory({ settingsFile, ...(agentEnvFile !== undefined ? { agentEnvFile } : {}) });
        profile = { provider: 'qianwenai', ...client.publicProfile };
        await save('review-profile-public.json', profile);
        return client;
      })();
    },
  };
}
export function maintenanceProviderSummary(records, generationProfile, reviewRouting) {
  const summarize = (kind, profile, modelListRequests) => {
    const matching = records.filter(record => (record.stage === 'generation' ? 'generation' : 'review') === kind);
    const reportedUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    for (const record of matching) for (const key of Object.keys(reportedUsage)) {
      const value = record.providerResponse?.usage?.[key];
      if (Number.isFinite(value) && value >= 0) reportedUsage[key] += value;
    }
    return { profile, modelListRequests, modelListFetched: false, modelSelectionSource: 'configured_model', chatRequests: matching.filter(record => record.requestWritten).length,
      usageUnknownRequests: matching.filter(record => record.requestWritten && !record.providerResponse?.usage).length, reportedUsage };
  };
  return { generation: summarize('generation', generationProfile, 0),
    review: summarize('review', reviewRouting.profile ?? plannedReviewProfile, reviewRouting.modelListRequests) };
}
