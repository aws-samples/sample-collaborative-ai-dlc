// Every runtime handler id the capability registry names must be declared by
// the module that implements it, and every declared id must be registered. The
// registry's own load-time check only proves it agrees with itself; this test
// ties each id to real runtime code, so a capability cannot be marked handled
// while nothing implements it.

import { describe, expect, it } from 'vitest';
import { RUNTIME_HANDLERS } from '../aidlc-capabilities.js';
import { IMPLEMENTED_RUNTIME_HANDLERS as executionPlan } from '../v2-execution-plan.js';
import { IMPLEMENTED_RUNTIME_HANDLERS as gatePreconditions } from '../gate-preconditions.js';
import { IMPLEMENTED_RUNTIME_HANDLERS as runStage } from '../../agentcore/commands/run-stage.js';
import { IMPLEMENTED_RUNTIME_HANDLERS as stageMaterializer } from '../../agentcore/stage-materializer.js';
import { IMPLEMENTED_RUNTIME_HANDLERS as sensorRunner } from '../../agentcore/sensor-runner.js';
import { IMPLEMENTED_RUNTIME_HANDLERS as cliDrivers } from '../../agentcore/cli/drivers.js';
import { IMPLEMENTED_RUNTIME_HANDLERS as mcpServer } from '../../agentcore/mcp/server.js';
import { IMPLEMENTED_RUNTIME_HANDLERS as processBridge } from '../../agentcore/mcp/process-bridge.js';
import { IMPLEMENTED_RUNTIME_HANDLERS as orchestrator } from '../../v2-orchestrator/index.js';
import { IMPLEMENTED_RUNTIME_HANDLERS as orchestratorSection } from '../../v2-orchestrator/section.js';

const DECLARED = {
  'shared/v2-execution-plan.js': executionPlan,
  'shared/gate-preconditions.js': gatePreconditions,
  'agentcore/commands/run-stage.js': runStage,
  'agentcore/stage-materializer.js': stageMaterializer,
  'agentcore/sensor-runner.js': sensorRunner,
  'agentcore/cli/drivers.js': cliDrivers,
  'agentcore/mcp/server.js': mcpServer,
  'agentcore/mcp/process-bridge.js': processBridge,
  'v2-orchestrator/index.js': orchestrator,
  'v2-orchestrator/section.js': orchestratorSection,
};

describe('runtime handler ownership', () => {
  it('declares an implementing module for every registered handler', () => {
    const declared = new Set(Object.values(DECLARED).flat());
    expect([...RUNTIME_HANDLERS].filter((id) => !declared.has(id))).toEqual([]);
  });

  it('declares only handlers the registry knows', () => {
    for (const [module, ids] of Object.entries(DECLARED)) {
      expect({ module, unknown: ids.filter((id) => !RUNTIME_HANDLERS.has(id)) }).toEqual({
        module,
        unknown: [],
      });
    }
  });
});
