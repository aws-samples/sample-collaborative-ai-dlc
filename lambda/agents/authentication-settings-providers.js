// Composition root for authentication settings providers: static imports and one list, read
// only by authentication-settings-service.js. Keys has no entry: its flows are the built-in
// credential routes.
import { BEDROCK_IAM_SETTINGS } from './authentication-iam-settings.js';

export const AUTHENTICATION_SETTINGS_PROVIDERS = Object.freeze([BEDROCK_IAM_SETTINGS]);
