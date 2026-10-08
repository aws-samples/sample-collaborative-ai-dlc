// Real stdio startup with a DynamoDB Local store injected through the runtime
// seam. Credential acquisition is tested separately; scope validation is real.
import { startMcpServer } from '../../mcp/index.js';
import { ddb } from '../../clients.js';
import { createProcessStore } from '../../../shared/v2-process-store.js';

const store =
  process.env.V2_MCP_MODE === 'discussion'
    ? undefined
    : createProcessStore({ ddb, tableName: process.env.V2_PROCESS_TABLE });

// Fault injection lives only in this test entrypoint, never in production startup.
let failures = Number(process.env.TEST_MCP_EXECUTION_READ_FAILURES) || 0;
if (store && failures > 0) {
  const getExecution = store.getExecution;
  store.getExecution = async (...args) => {
    if (failures-- > 0) {
      throw Object.assign(new Error('temporary read failure'), { name: 'ThrottlingException' });
    }
    return getExecution(...args);
  };
}

startMcpServer({ store }).catch((error) => {
  console.error('[agentcore-mcp] fatal:', error);
  process.exit(1);
});
