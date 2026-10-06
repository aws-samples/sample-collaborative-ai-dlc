import { AGENT_AUTH_MODES, commandDefinition } from './command-registry.js';
import { connectionVerificationFailure, verifyConnection } from './commands/verify-connection.js';

// Foundation authentication commands. Providers register verifiers with the runtime host
// (credential-material-registry.js), never commands, resolvers or failure mappers here.
export const AUTHENTICATION_BINDING_RESOLVERS = Object.freeze({
  // A verification checks exactly the connection the caller signed, never a pinned one.
  [AGENT_AUTH_MODES.VERIFY_CONNECTION]: ({ payload }) =>
    payload.credentialBinding ? [payload.credentialBinding] : [],
});
export const authenticationCommandFailure = (command, error) =>
  commandDefinition(command)?.agentAuth === AGENT_AUTH_MODES.VERIFY_CONNECTION
    ? connectionVerificationFailure(error)
    : null;
export const authenticationCommandHandlers = () => ({ verifyConnection });
