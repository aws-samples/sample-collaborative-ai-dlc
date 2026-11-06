import type { ComponentProps } from 'react';
import { ArtifactHtmlFrame, rendersAsHtml } from '@/components/intent/ArtifactHtmlFrame';
import { ArtifactMarkdown } from '@/components/intent/ArtifactMarkdown';

type Props = ComponentProps<typeof ArtifactMarkdown> & {
  // Required, so every caller states what kind of artifact it is showing.
  artifactType: string | null | undefined;
  title?: string | null;
};

export function ArtifactContent({ artifactType, title, ...props }: Props) {
  return rendersAsHtml(artifactType, props.content) ? (
    <ArtifactHtmlFrame content={props.content} title={title} />
  ) : (
    <ArtifactMarkdown {...props} />
  );
}
