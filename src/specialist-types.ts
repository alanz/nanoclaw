import fs from 'fs';

import { SPECIALISTS_JSON_PATH } from './config.js';
import { logger } from './logger.js';
import { SpecialistType } from './types.js';

let registry: SpecialistType[] | null = null;

/** Load and cache the specialist type registry from the given path (default: SPECIALISTS_JSON_PATH). */
export function loadSpecialistTypes(
  filePath: string = SPECIALISTS_JSON_PATH,
): SpecialistType[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      logger.error({ filePath }, 'specialists.json must be a JSON array');
      return [];
    }
    return parsed as SpecialistType[];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug(
        { filePath },
        'specialists.json not found — no specialist types registered',
      );
    } else {
      logger.error({ err, filePath }, 'Failed to load specialists.json');
    }
    return [];
  }
}

/** Initialise the registry at startup. Must be called before getSpecialistType/getAllSpecialistTypes. */
export function initSpecialistTypes(
  filePath: string = SPECIALISTS_JSON_PATH,
): void {
  registry = loadSpecialistTypes(filePath);
  logger.info({ count: registry.length }, 'Specialist types loaded');
}

/** Return all registered specialist types. Returns [] if not yet initialised. */
export function getAllSpecialistTypes(): SpecialistType[] {
  return registry ?? [];
}

/** Look up a specialist type by name. Returns undefined if not found. */
export function getSpecialistType(name: string): SpecialistType | undefined {
  return (registry ?? []).find((t) => t.name === name);
}

/** @internal — for tests only. Directly set the in-memory registry. */
export function _setSpecialistTypesForTest(types: SpecialistType[]): void {
  registry = types;
}

/** @internal — for tests only. Reset the registry to uninitialised state. */
export function _resetSpecialistTypesForTest(): void {
  registry = null;
}
