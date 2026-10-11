import { createNestApp } from '../src/api/app.ts';
import { config } from 'dotenv';
import { createIntakeService } from '../src/intake/service.mjs';

config({ quiet: true });

const port = Number(process.env.TUTOR_PORT ?? 4318);
const application = await createNestApp({
  intakeServiceFactory: ({ repository }) => createIntakeService({ storage: repository.intakeStorage }),
});
for (const warning of application.migration.warnings) console.warn(`存储迁移：${warning.message} (${warning.sourcePath})`);
await application.app.listen(port, '127.0.0.1');
console.log(`Tutor: http://127.0.0.1:${port} · NestJS + SQLite`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await application.close(); process.exitCode = 0; });
