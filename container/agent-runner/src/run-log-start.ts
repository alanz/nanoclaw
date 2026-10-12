/** Side-effect import: start the runner's run log before anything else logs. Imported first by index.ts. */
import { startRunLog } from './run-log.js';

startRunLog('runner');
