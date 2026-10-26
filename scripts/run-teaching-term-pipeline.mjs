import path from 'node:path';
import os from 'node:os';
import { runTeachingTermMaintenance } from './lib/teaching-term-maintenance.mjs';

const args = process.argv.slice(2);
const usage = 'node scripts/run-teaching-term-pipeline.mjs --inputs <JSON> --output-dir <new-directory> [--model-settings <model-settings.json>] [--qwen-agent-env <explicit-offline-env-file>] [--concurrency 1..4] [--method-references <comma-separated-ids>] [--recover-format]';
if (args.length === 1 && args[0] === '--help') { console.log(usage); } else {
  try {
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--recover-format') {
        if (options[args[i]] !== undefined) throw Error('invalid_arguments');
        options[args[i]] = true;
        continue;
      }
      if (!['--inputs', '--output-dir', '--model-settings', '--concurrency', '--method-references', '--qwen-agent-env'].includes(args[i]) || args[i + 1] === undefined || options[args[i]] !== undefined) throw Error('invalid_arguments');
      options[args[i]] = args[i + 1];
      i++;
    }
    if (!options['--inputs'] || !options['--output-dir']) throw Error('missing_inputs_or_output');
    const result = await runTeachingTermMaintenance({ inputFile: path.resolve(options['--inputs']), outputDirectory: path.resolve(options['--output-dir']),
      settingsFile: path.resolve(options['--model-settings'] ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData/Roaming'), 'fun.mrzys.tutor/model-settings.json')),
      agentEnvFile: options['--qwen-agent-env'] === undefined ? undefined : path.resolve(options['--qwen-agent-env']),
      methodReferences: options['--method-references'] === undefined ? [] : options['--method-references'].split(',').map(id => id.trim()),
      concurrency: options['--concurrency'] === undefined ? 3 : Number(options['--concurrency']), recoverFormat: options['--recover-format'] ?? false, onProgress: value => console.log(JSON.stringify(value)) });
    console.log(JSON.stringify(result));
    if (result.summary.failedQuestions.length) process.exitCode = 1;
  } catch (e) {
    // Do not echo arbitrary exception messages, input material or provider bodies.
    console.error(JSON.stringify({ error: typeof e?.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(e.code) ? e.code : 'maintenance_failed', usage }));
    process.exitCode = 1;
  }
}
