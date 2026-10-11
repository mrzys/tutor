import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppServer } from '../server.mjs';
import { registerSqliteStorage } from '../storage/sqlite.mjs';
import { createAuthService } from '../auth/service.mjs';
import { installUserAccess } from '../auth/access.mjs';

class TutorApplicationModule {}
Module({})(TutorApplicationModule);

export interface TutorApplicationOptions {
  root?: string;
  storeRoot?: string;
  databasePath?: string;
  legacyOptions?: Record<string, unknown>;
  intakeServiceFactory?: (context: { repository: any }) => unknown | Promise<unknown>;
  logger?: false;
}

/** One HTTP listener, with Nest owning lifecycle and existing domain handlers retaining their contracts. */
export async function createNestApp(options: TutorApplicationOptions = {}) {
  const root = options.root ?? fileURLToPath(new URL('../../', import.meta.url));
  const storeRoot = options.storeRoot ?? path.join(root, '.tutor', 'drafts');
  const storage = await registerSqliteStorage(path.dirname(storeRoot), options.databasePath, { questionBankRoot: root });
  let app: NestExpressApplication | undefined;
  try {
    const access = installUserAccess(storage.repository);
    const auth = createAuthService(storage.repository, { onFirstUser: access.claimLegacy });
    const intakeService = options.intakeServiceFactory
      ? await options.intakeServiceFactory({ repository: storage.repository }) : undefined;
    const legacy = createAppServer({ ...{ intakeStorage: storage.repository.intakeStorage },
      ...options.legacyOptions, root, storeRoot, ...(intakeService ? { intakeService } : {}) });
    app = await NestFactory.create<NestExpressApplication>(TutorApplicationModule, {
      bodyParser: false, logger: options.logger ?? ['error', 'warn'],
    });
    app.getHttpAdapter().getInstance().disable('x-powered-by');
    app.use(async (request: Request, response: Response) => {
      try {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (await auth.handle(request, response, url)) return;
        if (url.pathname.startsWith('/api/')) {
          const user = auth.authenticate(request);
          if (!user) {
            response.status(401).set('Cache-Control', 'no-store').json({ ok: false,
              error: { code: 'authentication_required', message: '请先登录后继续。' } }); return;
          }
          if (!['GET', 'HEAD'].includes(request.method)) auth.assertSameOrigin(request);
          access.run(user, () => legacy.emit('request', request, response)); return;
        }
        legacy.emit('request', request, response);
      } catch (cause: any) {
        response.status(cause.status ?? 500).set('Cache-Control', 'no-store').json({ ok: false,
          error: { code: cause.code ?? 'server_error', message: cause.status ? cause.message : '服务暂不可用。' } });
      }
    });
    await app.init();
    let closed = false;
    return { app, repository: storage.repository, migration: storage.migration,
      async close() {
        if (closed) return;
        closed = true;
        try { await app!.close(); } finally { storage.close(); }
      },
    };
  } catch (cause) {
    await app?.close(); storage.close(); throw cause;
  }
}
