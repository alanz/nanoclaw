import type Database from 'better-sqlite3';

export async function loadSqliteVecExtension(params: {
  db: Database.Database;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const sqliteVec = await import('sqlite-vec');
    sqliteVec.load(params.db as unknown as Parameters<typeof sqliteVec.load>[0]);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
