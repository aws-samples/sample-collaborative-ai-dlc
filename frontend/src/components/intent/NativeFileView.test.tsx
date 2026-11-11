import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import type { NativePublishedFile } from '@/services/nativeIntents';
import type { NativeRevisionFile } from '@/services/nativeHistory';
import { NativeFileView } from './NativeFileView';

vi.mock('@/components/discussion/DiscussButton', () => ({
  DiscussButton: () => <button>Discuss file</button>,
}));

afterEach(cleanup);

const view = (path: string, content: string | null, bytes: number) => {
  const descriptor: NativePublishedFile = {
    id: `nf-${'a'.repeat(64)}`,
    path,
    bytes,
    sha256: 'b'.repeat(64),
    mediaType: 'application/octet-stream',
    role: 'code',
  };
  const file: NativeRevisionFile = {
    ...descriptor,
    publicationId: 'c'.repeat(64),
    publicationSequence: 7,
    encoding: content === null ? 'binary' : 'utf8',
    content,
    truncated: false,
  };
  return render(
    <MemoryRouter>
      <NativeFileView
        file={file}
        descriptor={descriptor}
        createdAt="2026-11-11T11:00:00Z"
        publicationSequence={7}
        resultScope={{
          projectId: 'space',
          executionId: 'intent',
          onAccessFailure: vi.fn(),
        }}
      />
    </MemoryRouter>,
  );
};

it.each(['.env', '.npmrc'])(
  'shows repository %s content literally and identifies its download revision',
  (path) => {
    const content = 'PASSWORD=repository-owned-value\n<script>window.untrusted = true</script>';
    const rendered = view(path, content, new TextEncoder().encode(content).length);
    expect(rendered.container.querySelector('pre code')).toHaveTextContent(
      'PASSWORD=repository-owned-value',
    );
    expect(rendered.container.querySelector('pre code')).toHaveTextContent(
      '<script>window.untrusted = true</script>',
    );
    expect(rendered.container.querySelector('script')).toBeNull();
    expect(screen.getByText(/from published revision 7/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare file download' })).toBeEnabled();
  },
);

it('distinguishes an empty published template from an unavailable file', () => {
  view('.env.example', '', 0);
  expect(screen.getByText('Empty file (0 bytes).')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Prepare file download' })).toBeEnabled();
  expect(screen.queryByText(/Preview is not available/)).not.toBeInTheDocument();
});

it('keeps a binary file obtainable without pretending it has a text preview', () => {
  view('asset.bin', null, 3);
  expect(screen.getByText(/Binary file.*Preview is not available/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Prepare file download' })).toBeEnabled();
});
