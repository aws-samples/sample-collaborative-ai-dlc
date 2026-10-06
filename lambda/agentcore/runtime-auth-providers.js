// Composition root for runtime authentication providers: static imports and one list, read
// only by credential-material-registry.js. Static imports keep container-deps.test.js walking
// every provider dependency the image must install.
import { KEYS_RUNTIME_PROVIDER } from './keys-runtime-provider.js';

export const RUNTIME_AUTH_PROVIDERS = Object.freeze([KEYS_RUNTIME_PROVIDER]);
