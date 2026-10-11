import { AsyncLocalStorage } from 'node:async_hooks';

const requests = new AsyncLocalStorage();
const denied = () => Object.assign(new Error('没有找到该记录。'), { status: 404, code: 'not_found' });

/** Request-local ownership: shared bank, private teaching work, no administrator bypass. */
export function installUserAccess(repository) {
  const db = repository.database;
  db.exec(`CREATE TABLE IF NOT EXISTS resource_owners(
    kind TEXT NOT NULL, id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(user_id),
    PRIMARY KEY(kind,id));
    CREATE INDEX IF NOT EXISTS resource_owners_user ON resource_owners(user_id,kind);`);
  const owner = (kind, id) => db.prepare('SELECT user_id FROM resource_owners WHERE kind=? AND id=?').get(kind, id)?.user_id;
  const identity = (kind, id) => ['feedback', 'outputs'].includes(kind) ? ['papers', id.split('/')[0]] : [kind, id];
  const allowed = (kind, id) => {
    const user = requests.getStore();
    return !user || owner(...identity(kind, id)) === user.userId;
  };
  const claim = (kind, id) => {
    const user = requests.getStore();
    if (user) db.prepare('INSERT OR IGNORE INTO resource_owners VALUES(?,?,?)').run(kind, id, user.userId);
  };
  const original = Object.fromEntries(['get', 'list', 'put', 'warnings', 'getQuestionImport', 'putQuestionImport', 'listQuestionImports']
    .map(key => [key, repository[key].bind(repository)]));
  repository.get = (kind, id) => allowed(kind, id) ? original.get(kind, id) : null;
  repository.list = kind => original.list(kind).filter(id => allowed(kind, id));
  repository.warnings = kind => requests.getStore() ? [] : original.warnings(kind);
  repository.put = (kind, id, value, options) => db.transaction(() => {
    if (requests.getStore()) {
      if (original.get(kind, id) && !allowed(kind, id)) throw denied();
      if (['feedback', 'outputs'].includes(kind) && !allowed(kind, id)) throw denied();
      if (kind === 'papers' && !allowed('drafts', value.paper.sourceDraftId)) throw denied();
    }
    const result = original.put(kind, id, value, options);
    claim(kind, id);
    return result;
  }).immediate();
  repository.getQuestionImport = id => allowed('imports', id) ? original.getQuestionImport(id) : null;
  repository.listQuestionImports = () => original.listQuestionImports().filter(record => record && allowed('imports', record.importId));
  repository.putQuestionImport = (record, source) => db.transaction(() => {
    if (original.getQuestionImport(record.importId) && !allowed('imports', record.importId)) throw denied();
    original.putQuestionImport(record, source); claim('imports', record.importId);
  }).immediate();
  const intakeGet = repository.intakeStorage.get;
  repository.intakeStorage.get = async id => allowed('intake', id) ? intakeGet(id) : null;
  repository.beforeIntakeWrite = session => {
    if (db.prepare('SELECT 1 FROM intake_sessions WHERE id=?').get(session.sessionId)
      && !allowed('intake', session.sessionId)) throw denied();
  };
  repository.afterIntakeWrite = session => claim('intake', session.sessionId);
  return {
    run: (user, action) => requests.run(user, action),
    claimLegacy(user) {
      const insert = db.prepare('INSERT OR IGNORE INTO resource_owners VALUES(?,?,?)');
      for (const row of db.prepare('SELECT kind,id FROM documents').all()) insert.run(row.kind, row.id, user.userId);
      for (const row of db.prepare('SELECT id FROM intake_sessions').all()) insert.run('intake', row.id, user.userId);
      for (const row of db.prepare('SELECT import_id FROM question_imports').all()) insert.run('imports', row.import_id, user.userId);
    },
  };
}
