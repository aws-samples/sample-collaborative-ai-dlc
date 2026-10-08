// Only this test entry supplies ambient/inert credentials to a process store.
// The deployed MCP entry always requires broker-authorized execution data.
import { startMcpServer } from '../../mcp/index.js';
import { ddb } from '../../clients.js';
import { createProcessStore } from '../../../shared/v2-process-store.js';

await startMcpServer({
  store: createProcessStore({ ddb, tableName: process.env.V2_PROCESS_TABLE }),
});
