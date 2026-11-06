import { writeFileSync } from 'node:fs';
import { gatewayToolDefinitions } from './tool-definitions.js';

const target = new URL('../gateway-tools.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(gatewayToolDefinitions(), null, 2)}\n`);
