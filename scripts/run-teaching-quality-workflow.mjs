import path from 'node:path';
import os from 'node:os';
import { runTeachingQualityMaintenance } from './lib/teaching-quality-maintenance.mjs';

const args = process.argv.slice(2);
const usage = 'node scripts/run-teaching-quality-workflow.mjs --inputs <JSON> --output-dir <new-directory> [--model-settings <model-settings.json>] [--qwen-agent-env <explicit-offline-env-file>] [--concurrency 1..4] [--method-references <comma-separated-ids>]';
if (args.length === 1 && args[0] === '--help') console.log(usage);
else {
  try {
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i];
      if (!['--inputs', '--output-dir', '--model-settings', '--concurrency', '--method-references', '--qwen-agent-env'].includes(key)
        || args[i + 1] === undefined || Object.hasOwn(options, key)) throw Error('invalid_arguments');
      options[key] = args[i + 1];
    }
    if (!options['--inputs'] || !options['--output-dir']) throw Error('missing_inputs_or_output');
    const result = await runTeachingQualityMaintenance({ inputFile: path.resolve(options['--inputs']),
      outputDirectory: path.resolve(options['--output-dir']),
      settingsFile: path.resolve(options['--model-settings'] ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData/Roaming'), 'fun.mrzys.tutor/model-settings.json')),
      agentEnvFile: options['--qwen-agent-env'] === undefined ? undefined : path.resolve(options['--qwen-agent-env']),
      methodReferences: options['--method-references'] === undefined ? [] : options['--method-references'].split(',').map(id => id.trim()),
      concurrency: options['--concurrency'] === undefined ? 3 : Number(options['--concurrency']),
      onProgress: value => console.log(JSON.stringify(value)) });
    console.log(JSON.stringify(result));
    if (result.summary.failedQuestions.length) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ error: typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/u.test(error.code) ? error.code : 'maintenance_failed', usage }));
    process.exitCode = 1;
  }
}
