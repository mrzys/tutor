import { createAppServer } from '../src/server.mjs';

const port = Number(process.env.TUTOR_PORT ?? 4318);
const server = createAppServer();
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Tutor: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
