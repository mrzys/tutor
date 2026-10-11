import path from 'node:path';

const storageRegistrations = new Map();
const questionBankRegistrations = new Map();

export function registerStorage(baseRoot, repository) {
  storageRegistrations.set(path.resolve(baseRoot), repository);
}

export function unregisterStorage(baseRoot) {
  storageRegistrations.delete(path.resolve(baseRoot));
}

export function registeredStorage(baseRoot) {
  return storageRegistrations.get(path.resolve(baseRoot)) ?? null;
}

export function storageForDirectory(directory, expectedKind) {
  const resolved = path.resolve(directory);
  for (const [baseRoot, repository] of storageRegistrations) {
    if (path.relative(baseRoot, resolved) === expectedKind) return repository;
  }
  return null;
}

export function registerQuestionBank(root, repository) {
  questionBankRegistrations.set(path.resolve(root), repository);
}

export function unregisterQuestionBank(root) {
  questionBankRegistrations.delete(path.resolve(root));
}

export function questionBankStorage(root) {
  return questionBankRegistrations.get(path.resolve(root)) ?? null;
}
