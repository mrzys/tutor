import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppServer } from '../server.mjs';
import { registerSqliteStorage } from '../storage/sqlite.mjs';

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
  const storage = await registerSqliteStorage(path.dirname(storeRoot), options.databasePath);
  let app: NestExpressApplication | undefined;
  try {
    const intakeService = options.intakeServiceFactory
      ? await options.intakeServiceFactory({ repository: storage.repository }) : undefined;
    const legacy = createAppServer({ ...options.legacyOptions, root, storeRoot, ...(intakeService ? { intakeService } : {}) });
    app = await NestFactory.create<NestExpressApplication>(TutorApplicationModule, {
      bodyParser: false, logger: options.logger ?? ['error', 'warn'],
    });
    app.getHttpAdapter().getInstance().disable('x-powered-by');
    app.use((request: Request, response: Response) => legacy.emit('request', request, response));
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
