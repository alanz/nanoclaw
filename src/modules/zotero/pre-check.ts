import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';

const PRE_CHECK_TIMEOUT_MS = 10_000;

/**
 * Lightweight pre-check: fetch the current library version from Zotero API.
 * Returns null on missing credentials, non-OK HTTP response, or network error.
 * Fail-closed — callers treat null as "skip this sync cycle".
 */
export async function fetchLibraryVersion(lastVersion: number): Promise<number | null> {
  const env = readEnvFile(['ZOTERO_API_KEY', 'ZOTERO_USER_ID']);
  const apiKey = env.ZOTERO_API_KEY;
  const userId = env.ZOTERO_USER_ID;

  if (!apiKey || !userId) {
    log.warn('Zotero credentials not configured, skipping sync');
    return null;
  }

  const url = `https://api.zotero.org/users/${userId}/items` + `?since=${lastVersion}&format=versions&limit=1`;

  try {
    const res = await fetch(url, {
      headers: {
        'Zotero-API-Key': apiKey,
        'Zotero-API-Version': '3',
      },
      signal: AbortSignal.timeout(PRE_CHECK_TIMEOUT_MS),
    });

    if (!res.ok) {
      log.warn('Zotero version pre-check failed', { status: res.status });
      return null;
    }

    return parseInt(res.headers.get('Last-Modified-Version') ?? '0', 10);
  } catch (err) {
    log.warn('Zotero version pre-check error', { err });
    return null;
  }
}
