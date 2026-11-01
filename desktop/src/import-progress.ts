/** Committed-state invalidation only. Read SQLite through IPC for actual job
 * state, content, permissions or errors; sequence can restart with the app. */
export type ImportProgressEvent = {
  importId: string;
  jobId?: string;
  status: string;
  stage: string;
  revision?: number;
  sequence: number;
};
