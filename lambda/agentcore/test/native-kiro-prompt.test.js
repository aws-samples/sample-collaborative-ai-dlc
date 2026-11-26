import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { kiroPromptHash, resolveKiroPromptEvidence } from '../native/kiro-prompt.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, open: vi.fn(actual.open) };
});

const actualFs = await vi.importActual('node:fs/promises');
const roots = [];
const digest = (text) => createHash('sha256').update(text).digest('hex');
const fixture = async (body = '---\nname: aidlc\n---\nRequest: $ARGUMENTS\n') => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'kiro-prompt-'));
  roots.push(root);
  const project = join(root, 'project');
  const file = join(project, '.kiro/skills/aidlc/SKILL.md');
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, body, { mode: 0o600 });
  return { root, project, file };
};
const evidence = (project, prompt = '/aidlc poc ask for a title') =>
  resolveKiroPromptEvidence({ project, prompt });

afterEach(async () => {
  vi.mocked(open).mockReset().mockImplementation(actualFs.open);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native Kiro prompt evidence', () => {
  it('canonicalizes only CRLF and surrounding whitespace for the hash', () => {
    expect(kiroPromptHash(' \r\nHello  world\r\nnext\r\n ')).toBe(digest('Hello  world\nnext'));
    expect(kiroPromptHash('Hello world')).not.toBe(kiroPromptHash('Hello  world'));
  });

  it('hashes a literal prompt without reading a skill or requiring an existing project', async () => {
    expect(await evidence('/nonexistent/kiro-project', '  Please discuss /aidlc.\r\n')).toEqual({
      userPromptSha256: digest('Please discuss /aidlc.'),
      userPromptSource: 'literal',
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('expands every slot after frontmatter removal and preserves dollar arguments literally', async () => {
    const { project } = await fixture(
      '---\r\nname: aidlc\r\ndescription: hidden $ARGUMENTS\r\n---\r\n\r\n# Task\r\n$ARGUMENTS\r\nAgain: $ARGUMENTS\r\n',
    );
    const args = "poc preserve $$, $&, $`, $\\', $(not-executed), and $ARGUMENTS";
    expect(await evidence(project, `/aidlc ${args}`)).toEqual({
      userPromptSha256: digest(`# Task\n${args}\nAgain: ${args}`),
      userPromptSource: 'aidlc-skill-expansion',
    });
  });

  it('accepts a bounded plain skill body without frontmatter', async () => {
    const { project } = await fixture('Follow:\n$ARGUMENTS\n---\nKeep this body separator.');
    expect(await evidence(project)).toEqual({
      userPromptSha256: digest('Follow:\npoc ask for a title\n---\nKeep this body separator.'),
      userPromptSource: 'aidlc-skill-expansion',
    });
  });

  it.each(['/other task', '/aidlc', '/aidlc\tpoc', '/aidlc\npoc', ' /aidlc poc', '/aidlc   '])(
    'rejects unsupported slash form %j',
    async (prompt) => {
      await expect(evidence('/nonexistent/kiro-project', prompt)).rejects.toThrow(
        'Invalid native Kiro prompt evidence',
      );
      expect(open).not.toHaveBeenCalled();
    },
  );

  it.each([
    '',
    '---\nname: aidlc\n$ARGUMENTS',
    '---invalid\n$ARGUMENTS',
    '---\n---\n$ARGUMENTS',
    '---\nname: aidlc\n---\n  ',
    '---\nname: aidlc\n---\nNo argument slot.',
    '$ARGUMENTS\0',
    Buffer.from([0xff, 0xfe, 0xfd]),
  ])('rejects malformed, empty, slotless or invalid UTF-8 skills %#', async (body) => {
    const { project } = await fixture(body);
    await expect(evidence(project)).rejects.toThrow('Invalid native Kiro prompt evidence');
  });

  it('rejects a missing skill with a fixed error that does not expose its path', async () => {
    const { project, file } = await fixture();
    await rm(file);
    await expect(evidence(project)).rejects.toThrow(/^Invalid native Kiro prompt evidence$/);
  });

  it('rejects skill bytes beyond 256 KiB and expansion beyond 1 MiB', async () => {
    const { project, file } = await fixture(Buffer.alloc(256 * 1024 + 1, 'a'));
    await expect(evidence(project)).rejects.toThrow();
    await writeFile(file, '$ARGUMENTS'.repeat(65));
    await expect(evidence(project, `/aidlc ${'a'.repeat(16 * 1024)}`)).rejects.toThrow();
  });

  it.each(['', ' ', '\0', 'a'.repeat(1024 * 1024 + 1)])(
    'rejects empty, invalid or oversized prompts %#',
    async (prompt) => {
      await expect(evidence('/nonexistent/kiro-project', prompt)).rejects.toThrow();
    },
  );

  it.each(['.', '.kiro', '.kiro/skills', '.kiro/skills/aidlc', '.kiro/skills/aidlc/SKILL.md'])(
    'rejects a symlink at %s',
    async (relative) => {
      const { project } = await fixture();
      const path = join(project, relative);
      await rename(path, `${path}-target`);
      await symlink(`${path}-target`, path);
      await expect(evidence(project)).rejects.toThrow();
    },
  );

  it('rejects a hard-linked skill', async () => {
    const { root, project, file } = await fixture();
    await link(file, join(root, 'alias'));
    await expect(evidence(project)).rejects.toThrow();
  });

  it.each(['.', '.kiro', '.kiro/skills/aidlc/SKILL.md'])(
    'rejects an unsafe writable project descendant %s',
    async (relative) => {
      const { project } = await fixture();
      await chmod(join(project, relative), 0o777);
      await expect(evidence(project)).rejects.toThrow();
    },
  );

  it.each(['mutate-file', 'replace-file', 'replace-ancestor'])(
    'rejects %s during the descriptor read',
    async (change) => {
      const { project, file } = await fixture();
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        const handle = await actualFs.open(...args);
        const read = handle.read.bind(handle);
        let changed = false;
        handle.read = async (...readArgs) => {
          const result = await read(...readArgs);
          if (!changed) {
            changed = true;
            if (change === 'mutate-file') await writeFile(file, 'Changed: $ARGUMENTS\n');
            if (change === 'replace-file') {
              await rename(file, `${file}.old`);
              await writeFile(file, 'Changed: $ARGUMENTS\n');
            }
            if (change === 'replace-ancestor') {
              const parent = dirname(file);
              await rename(parent, `${parent}.old`);
              await symlink(`${parent}.old`, parent);
            }
          }
          return result;
        };
        return handle;
      });
      await expect(evidence(project)).rejects.toThrow();
    },
  );
});
