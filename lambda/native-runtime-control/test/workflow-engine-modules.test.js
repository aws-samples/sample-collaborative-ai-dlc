import { describe, expect, it } from 'vitest';
import { nativeEngineModuleSource } from '../workflow-engine/module-source.mjs';

describe('protected engine module loading', () => {
  it('passes pinned code and data through with the loader for their type', () => {
    for (const [path, loader] of [
      ['/engine/tools/aidlc-lib.ts', 'ts'],
      ['/adapter/observe.mjs', 'js'],
      ['/engine/tools/helper.js', 'js'],
      ['/engine/tools/data/stage-graph.json', 'json'],
      ['/engine/config.toml', 'toml'],
    ])
      expect(nativeEngineModuleSource(path, Buffer.from('content'))).toEqual({
        contents: 'content',
        loader,
      });
  });

  it('presents a text import of a sensor manifest as its exact content', async () => {
    // The pinned sensor tool imports its manifests `with { type: "text" }`.
    // Bun rejects a text loader from a plugin; every sensor failed to load.
    const manifest = '---\nid: required-sections\n---\nBody with `backticks`, "quotes" and ${x}.\n';
    const source = nativeEngineModuleSource(
      '/engine/sensors/aidlc-required-sections.md',
      Buffer.from(manifest),
    );
    expect(source.loader).toBe('js');
    const loaded = await import(
      `data:text/javascript;base64,${Buffer.from(source.contents).toString('base64')}`
    );
    expect(loaded.default).toBe(manifest);
  });

  it('refuses file types the pinned engine has no reason to load', () => {
    for (const path of [
      '/engine/hooks/run.sh',
      '/engine/tools/addon.node',
      '/engine/x.yaml',
      '/engine/README',
    ])
      expect(() => nativeEngineModuleSource(path, Buffer.from('x'))).toThrow(
        'NATIVE_ENGINE_MODULE_DENIED',
      );
  });
});
