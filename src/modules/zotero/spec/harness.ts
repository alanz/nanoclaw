/**
 * Tests propagated from specs/zotero.allium — see src/test-utils/spec-harness.ts
 * for the markers and how to refresh obligations.json.
 */
import path from 'path';
import { fileURLToPath } from 'url';

import { specHarness } from '../../../test-utils/spec-harness.js';

export const { OBLIGATIONS, obligation, divergence, unimplemented, covered, instructed } = specHarness(
  path.dirname(fileURLToPath(import.meta.url)),
);
