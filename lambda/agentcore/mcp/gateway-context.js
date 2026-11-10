import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();

// The control-plane grant travels with the invocation (including detached
// background jobs started inside it) but never through command payloads, so a
// handler cannot log, persist or forward it by accident.
export const runWithGatewayGrant = (grant, fn) => (grant ? context.run(grant, fn) : fn());
export const currentGatewayGrant = () => context.getStore() ?? null;
