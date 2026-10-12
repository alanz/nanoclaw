/** Side-effect import: start the MCP server's run log before anything else logs. Imported first by index.ts. */
import { startRunLog } from '../run-log.js';

startRunLog('mcp');
