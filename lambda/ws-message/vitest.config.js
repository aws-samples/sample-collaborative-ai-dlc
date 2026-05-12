import { mergeConfig, defineConfig } from 'vitest/config';
import base from '../../vitest.config.base.js';

export default mergeConfig(base, defineConfig({}));
