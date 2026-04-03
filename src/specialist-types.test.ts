import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SPECIALISTS_CONFIG } from './config.js';
import {
  _resetSpecialistTypesForTest,
  _setSpecialistTypesForTest,
  getAllSpecialistTypes,
  getSpecialistType,
  initSpecialistTypes,
  loadSpecialistTypes,
} from './specialist-types.js';

afterEach(() => {
  _resetSpecialistTypesForTest();
});

// ---------------------------------------------------------------------------
// SPECIALISTS_CONFIG values (mirror specialists.allium config block)
// ---------------------------------------------------------------------------

describe('SPECIALISTS_CONFIG', () => {
  it('maxSpecialistDepth is 5', () => {
    expect(SPECIALISTS_CONFIG.maxSpecialistDepth).toBe(5);
  });

  it('maxChainDelegations is 20', () => {
    expect(SPECIALISTS_CONFIG.maxChainDelegations).toBe(20);
  });

  it('maxSameTypeDispatches is 3', () => {
    expect(SPECIALISTS_CONFIG.maxSameTypeDispatches).toBe(3);
  });

  it('maxTaskDurationMs is 4 hours', () => {
    expect(SPECIALISTS_CONFIG.maxTaskDurationMs).toBe(4 * 60 * 60 * 1000);
  });

  it('containerTimeoutMs is 30 minutes', () => {
    expect(SPECIALISTS_CONFIG.containerTimeoutMs).toBe(30 * 60 * 1000);
  });

  it('maxRestartRetries is 2', () => {
    expect(SPECIALISTS_CONFIG.maxRestartRetries).toBe(2);
  });

  it('maxStagingDurationMs is 2 hours', () => {
    expect(SPECIALISTS_CONFIG.maxStagingDurationMs).toBe(2 * 60 * 60 * 1000);
  });

  it('defaultLastTurnSubNotice is non-empty', () => {
    expect(SPECIALISTS_CONFIG.defaultLastTurnSubNotice.length).toBeGreaterThan(
      0,
    );
  });

  it('defaultLastTurnParentNotice is non-empty', () => {
    expect(
      SPECIALISTS_CONFIG.defaultLastTurnParentNotice.length,
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// loadSpecialistTypes
// ---------------------------------------------------------------------------

describe('loadSpecialistTypes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-spec-types-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty array when the file does not exist', () => {
    const result = loadSpecialistTypes(path.join(tmpDir, 'missing.json'));
    expect(result).toEqual([]);
  });

  it('parses a valid specialists.json', () => {
    const filePath = path.join(tmpDir, 'specialists.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify([
        {
          name: 'researcher',
          description: 'Does research',
          isMemoryProvider: false,
        },
        {
          name: 'memory',
          description: 'Queries memory',
          isMemoryProvider: true,
        },
      ]),
    );
    const result = loadSpecialistTypes(filePath);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('researcher');
    expect(result[1].isMemoryProvider).toBe(true);
  });

  it('returns an empty array when the file contains invalid JSON', () => {
    const filePath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(filePath, 'not json {{{');
    expect(loadSpecialistTypes(filePath)).toEqual([]);
  });

  it('returns an empty array when the file contains a non-array JSON value', () => {
    const filePath = path.join(tmpDir, 'obj.json');
    fs.writeFileSync(filePath, JSON.stringify({ name: 'researcher' }));
    expect(loadSpecialistTypes(filePath)).toEqual([]);
  });

  it('preserves optional fields (lastTurnSubNotice, lastTurnParentNotice)', () => {
    const filePath = path.join(tmpDir, 'specialists.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify([
        {
          name: 'coder',
          description: 'Writes code',
          isMemoryProvider: false,
          lastTurnSubNotice: 'Final iteration sub notice',
          lastTurnParentNotice: 'Final iteration parent notice',
        },
      ]),
    );
    const [coder] = loadSpecialistTypes(filePath);
    expect(coder.lastTurnSubNotice).toBe('Final iteration sub notice');
    expect(coder.lastTurnParentNotice).toBe('Final iteration parent notice');
  });
});

// ---------------------------------------------------------------------------
// initSpecialistTypes / getAllSpecialistTypes / getSpecialistType
// ---------------------------------------------------------------------------

describe('initSpecialistTypes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-spec-types-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('populates the registry from the given file', () => {
    const filePath = path.join(tmpDir, 'specialists.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify([
        {
          name: 'researcher',
          description: 'Researcher',
          isMemoryProvider: false,
        },
      ]),
    );
    initSpecialistTypes(filePath);
    expect(getAllSpecialistTypes()).toHaveLength(1);
  });

  it('leaves the registry empty when the file is missing', () => {
    initSpecialistTypes(path.join(tmpDir, 'nope.json'));
    expect(getAllSpecialistTypes()).toHaveLength(0);
  });
});

describe('getAllSpecialistTypes', () => {
  it('returns an empty array before initialisation', () => {
    expect(getAllSpecialistTypes()).toEqual([]);
  });

  it('returns all types after _setSpecialistTypesForTest', () => {
    _setSpecialistTypesForTest([
      { name: 'researcher', description: 'r', isMemoryProvider: false },
      { name: 'memory', description: 'm', isMemoryProvider: true },
    ]);
    expect(getAllSpecialistTypes()).toHaveLength(2);
  });
});

describe('getSpecialistType', () => {
  beforeEach(() => {
    _setSpecialistTypesForTest([
      {
        name: 'researcher',
        description: 'Researcher',
        isMemoryProvider: false,
      },
      { name: 'memory', description: 'Memory', isMemoryProvider: true },
    ]);
  });

  it('returns the type for a known name', () => {
    const t = getSpecialistType('researcher');
    expect(t).toBeDefined();
    expect(t!.name).toBe('researcher');
    expect(t!.isMemoryProvider).toBe(false);
  });

  it('returns the memory provider type', () => {
    const t = getSpecialistType('memory');
    expect(t!.isMemoryProvider).toBe(true);
  });

  it('returns undefined for an unknown name', () => {
    expect(getSpecialistType('nonexistent')).toBeUndefined();
  });

  it('returns undefined before registry is initialised', () => {
    _resetSpecialistTypesForTest();
    expect(getSpecialistType('researcher')).toBeUndefined();
  });
});
