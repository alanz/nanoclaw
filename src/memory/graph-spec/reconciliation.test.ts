import path from 'path';
import { fileURLToPath } from 'url';

import { reconcileSpec } from '../../test-utils/spec-harness.js';

reconcileSpec(path.dirname(fileURLToPath(import.meta.url)), 'memory-graph');
