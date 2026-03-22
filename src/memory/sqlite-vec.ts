import type Database from 'better-sqlite3';

export async function loadSqliteVecExtension(params: {
  db: Database.Database;
  extensionPath?: string;
}): Promise<{ ok: boolean; extensionPath?: string; error?: string }> {
  try {
    const sqliteVec = await import('sqlite-vec');
    const resolvedPath = params.extensionPath?.trim()
      ? params.extensionPath.trim()
      : undefined;
    const extensionPath = resolvedPath ?? sqliteVec.getLoadablePath();

    // better-sqlite3 exposes loadExtension() directly (no enableLoadExtension step needed)
    if (resolvedPath) {
      params.db.loadExtension(extensionPath);
    } else {
      // sqlite-vec's load() calls db.loadExtension() internally — works with better-sqlite3
      sqliteVec.load(
        params.db as unknown as Parameters<typeof sqliteVec.load>[0],
      );
    }

    return { ok: true, extensionPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
