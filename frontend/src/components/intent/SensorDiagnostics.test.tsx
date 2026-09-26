import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SensorDetail } from '@/services/intents';
import { SENSOR_DIAGNOSTIC_LIMITS, SensorDiagnostics } from './SensorDiagnostics';

describe('SensorDiagnostics', () => {
  it('bounds diagnostic text, paths, and sample files before rendering', () => {
    const reason = `reason: ${'r'.repeat(1_000)} reason-tail`;
    const stderr = `stderr: ${'e'.repeat(5_000)} stderr-tail`;
    const longPath = `src/${'p'.repeat(700)}/secret-tail.ts`;

    const { container } = render(
      <SensorDiagnostics
        sensorId="lint"
        detail={{
          harnessFailures: [
            {
              reason,
              stderr,
              sampleFiles: [longPath],
            },
          ],
          files: [{ file: longPath, result: 'INCONCLUSIVE' }],
        }}
      />,
    );

    const renderedReason = screen.getByText(/^reason:/).textContent ?? '';
    expect(renderedReason).toHaveLength(SENSOR_DIAGNOSTIC_LIMITS.reasonChars);
    expect(renderedReason.endsWith('… [truncated]')).toBe(true);
    expect(renderedReason).not.toContain('reason-tail');

    const renderedStderr = container.querySelector('pre')?.textContent ?? '';
    expect(renderedStderr).toHaveLength(SENSOR_DIAGNOSTIC_LIMITS.diagnosticTextChars);
    expect(renderedStderr.endsWith('… [truncated]')).toBe(true);
    expect(renderedStderr).not.toContain('stderr-tail');

    expect(screen.queryByText(/secret-tail\.ts/)).not.toBeInTheDocument();
    expect(container.textContent).toContain('… [truncated]');
  });

  it('reports backend omissions and every frontend count cap deterministically', () => {
    const harnessFailures = Array.from({ length: 22 }, (_, index) => ({
      reason: `failure-${index}`,
      sampleFiles:
        index === 0 ? Array.from({ length: 7 }, (__, fileIndex) => `sample-${fileIndex}.ts`) : [],
    }));
    const files = Array.from({ length: 103 }, (_, index) => ({
      file: `file-${index}.ts`,
      result: 'FAIL',
    }));

    render(
      <SensorDiagnostics
        sensorId="lint"
        detail={{
          harnessFailures,
          files,
          filesOmitted: 37,
          omissionReason: 'diagnostic byte budget reached',
        }}
      />,
    );

    expect(screen.getAllByRole('listitem')).toHaveLength(
      SENSOR_DIAGNOSTIC_LIMITS.harnessFailures + SENSOR_DIAGNOSTIC_LIMITS.fileResults,
    );
    expect(screen.getByText(/2 additional samples hidden/)).toBeInTheDocument();
    expect(screen.getByText(/37 file results omitted/)).toHaveTextContent(
      'diagnostic byte budget reached',
    );
    expect(screen.getByText(/2 additional harness failure groups hidden/)).toBeInTheDocument();
    expect(screen.getByText(/3 additional file results hidden/)).toBeInTheDocument();
    expect(screen.queryByText('failure-20')).not.toBeInTheDocument();
    expect(screen.queryByText('file-100.ts')).not.toBeInTheDocument();
    expect(screen.getByText(/Samples:/)).toHaveTextContent(
      'sample-0.ts, sample-1.ts, sample-2.ts, sample-3.ts, sample-4.ts',
    );
    expect(screen.queryByText(/sample-5\.ts/)).not.toBeInTheDocument();
  });

  it('redacts credential-shaped legacy content at the display boundary', () => {
    const secrets = {
      authorization: 'secret-value',
      password: 'hunter2',
      accessKey: 'AKIAABCDEFGHIJKLMNOP',
      githubToken: `ghp_${'a'.repeat(20)}`,
      userInfo: 'alice:password',
      credentialPath: '/home/alice/.aws/credentials',
    };
    const detail: SensorDetail = {
      harnessFailures: [
        {
          reason: `Authorization: Token ${secrets.authorization}`,
          stderr: [
            `password=${secrets.password}`,
            secrets.accessKey,
            secrets.githubToken,
            `https://${secrets.userInfo}@example.com/repo.git`,
            secrets.credentialPath,
          ].join('\n'),
        },
      ],
      files: [
        {
          file: 'src/index.ts',
          detail: { reason: `api_key=${secrets.authorization}` },
        },
      ],
      filesOmitted: 1,
      omissionReason: `access_token=${secrets.authorization}`,
    };

    const { container } = render(
      <SensorDiagnostics sensorId={`sensor password=${secrets.password}`} detail={detail} />,
    );

    for (const secret of Object.values(secrets)) {
      expect(container.textContent).not.toContain(secret);
    }
    expect(container.textContent).toContain('[REDACTED]');
    expect(
      screen.getByLabelText('Bounded diagnostics for sensor password=[REDACTED]'),
    ).toBeVisible();
  });

  it.each([
    ['null detail', null],
    ['empty detail', {}],
    ['empty diagnostic arrays', { harnessFailures: [], files: [] }],
    ['non-positive omission count', { filesOmitted: 0 }],
  ] satisfies [string, SensorDetail | null][])('renders nothing for %s', (_name, detail) => {
    const { container } = render(<SensorDiagnostics sensorId="lint" detail={detail} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('exposes a named diagnostics container, semantic lists, and omission notes', () => {
    render(
      <SensorDiagnostics
        sensorId="lint-sensor"
        detail={{
          harnessFailures: [{ reason: 'tool unavailable' }],
          files: [{ file: 'src/index.ts', result: 'INCONCLUSIVE' }],
          filesOmitted: 4,
        }}
      />,
    );

    const diagnostics = screen.getByLabelText('Bounded diagnostics for lint-sensor');
    expect(diagnostics).toBeVisible();
    expect(within(diagnostics).getByText('Harness diagnostics')).toBeVisible();
    expect(within(diagnostics).getAllByRole('list')).toHaveLength(2);
    expect(within(diagnostics).getAllByRole('listitem')).toHaveLength(2);
    expect(within(diagnostics).getByRole('note')).toHaveTextContent(
      '4 file results omitted — omission reason unavailable.',
    );
  });
});
