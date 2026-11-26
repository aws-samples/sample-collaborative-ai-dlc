import type {
  NativeIntent,
  NativeInteractionView,
  NativePublication,
  NativeGraph,
  NativeFileContent,
} from '@/services/nativeIntents';

// Synthetic UI data, never a transcript or evidence from a live run.
export async function nativeInteractionFixture(scenario = 'waiting') {
  const sequence = scenario === 'next' ? 2 : 1;
  const publicationId = `preview-publication-${sequence}`;
  const messages: NativeInteractionView['messages'] =
    scenario === 'next'
      ? [
          {
            type: 'text',
            text: 'The workflow selection is recorded. What should the updated pipes look like?',
          },
        ]
      : [
          {
            type: 'text',
            text: 'Before starting, select the workflow for **Fix the pipe visualization**.',
          },
          {
            type: 'text',
            text: '| Workflow | Purpose |\n| --- | --- |\n| `default` | Full development lifecycle |\n| `poc` | A focused proof of concept |\n| Custom | Compose a workflow for this request |',
          },
          {
            type: 'text',
            text: 'Reply with a workflow name, or describe the workflow you want to compose.',
          },
        ];
  const canonical = JSON.stringify(messages.map(({ text, type }) => ({ text, type })));
  const contentSha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))),
  )
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const interaction: NativeInteractionView = {
    id: (sequence === 1 ? 'a' : 'b').repeat(64),
    sequence,
    kind: 'assistant_turn',
    harness: 'codex',
    publicationId,
    messages,
    contentSha256,
    createdAt: '2026-09-29T12:00:00Z',
    response: null,
  };
  const intent: NativeIntent = {
    id: 'preview-run',
    projectId: 'preview-project',
    executionBackend: 'native',
    title: 'Fix the pipe visualization',
    prompt: 'Improve the pipe visualization in flappy-bird. Keep the existing gameplay.',
    harness: 'codex',
    status: 'READY',
    executionAvailable: true,
    package: {
      version: '2.9.0',
      source: { provider: 'github', repository: 'awslabs/aidlc-workflows', release: 'v2.9.0' },
    },
    createdAt: '2026-09-29T11:00:00Z',
    updatedAt: '2026-09-29T12:00:00Z',
    execution: {
      status: 'AWAITING_USER',
      attemptId: 'preview-attempt',
      epoch: 1,
      startedAt: '2026-09-29T11:50:00Z',
      updatedAt: '2026-09-29T12:00:00Z',
      model: 'Preview fixture',
      repository: {
        provider: 'github',
        repository: 'example/flappy-bird',
        branch: 'main',
        commit: null,
      },
      publicationId,
      projectionStatus: 'complete',
      interactionId: interaction.id,
      turnSequence: sequence,
    },
  };
  const publication: NativePublication = {
    id: publicationId,
    sequence,
    createdAt: interaction.createdAt,
    files: [
      {
        id: 'preview-readme',
        path: 'README.md',
        bytes: 44,
        sha256: 'd'.repeat(64),
        role: 'code',
        mediaType: 'text/markdown',
      },
    ],
    question: null,
    projectionStatus: 'complete',
  };
  const file: NativeFileContent = {
    id: 'preview-readme',
    path: 'README.md',
    bytes: 44,
    sha256: 'd'.repeat(64),
    mediaType: 'text/markdown',
    encoding: 'utf8',
    content: '# Flappy bird\n\nSynthetic UI preview content.\n',
    publicationId,
  };
  const graph: NativeGraph = {
    publicationId,
    nodes: [
      { id: 'preview-intent', type: 'Intent', label: intent.title, intentId: intent.id },
      {
        id: 'preview-turn',
        type: 'NativeInteraction',
        label: 'AI-DLC response',
        interactionId: interaction.id,
        publicationId,
      },
      {
        id: 'preview-file',
        type: 'Artifact',
        label: 'README.md',
        artifactId: file.id,
        publicationId,
      },
    ],
    edges: [
      { source: 'preview-intent', target: 'preview-turn', label: 'CONTAINS' },
      { source: 'preview-intent', target: 'preview-file', label: 'CONTAINS' },
    ],
  };
  if (scenario === 'pending') {
    intent.execution = {
      ...intent.execution!,
      status: 'DISPATCHING',
      turnSequence: 2,
      responsePending: true,
    };
    interaction.response = {
      id: 'bed6a902-10ce-459c-87b3-e5689a57c57b',
      kind: 'user_reply',
      interactionId: interaction.id,
      sequence: 2,
      actorId: 'preview-member',
      text: 'Use the poc workflow.',
      acceptedAt: '2026-09-29T12:01:00Z',
      deliveryStatus: 'pending',
    };
  }
  return { intent, interaction, publication, file, graph };
}
