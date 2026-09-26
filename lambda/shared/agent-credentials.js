// Compatibility facade. Contracts are dependency-free; only the repository owns SSM paths.
export * from './agent-auth-catalog.js';
export * from './agent-key-repository.js';
import * as catalog from './agent-auth-catalog.js';
import * as repository from './agent-key-repository.js';
export default { ...catalog, ...repository };
