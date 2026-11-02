// Test-only filesystem routing. The production command is executed unchanged,
// including shell quoting, embedded functions, JSON serialization and exit code.
import { registerHooks } from 'node:module';

const filesystem = new URL('./native-recovery-filesystem.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'node:fs/promises' && context.parentURL !== filesystem)
      return { url: filesystem, shortCircuit: true };
    return next(specifier, context);
  },
});
