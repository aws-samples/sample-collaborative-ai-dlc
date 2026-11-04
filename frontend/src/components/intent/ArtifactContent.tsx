import type { ComponentProps } from 'react';
import { ArtifactHtmlFrame, isHtmlDocument } from '@/components/intent/ArtifactHtmlFrame';
import { ArtifactMarkdown } from '@/components/intent/ArtifactMarkdown';

type Props = ComponentProps<typeof ArtifactMarkdown> & { title?: string | null };

export function ArtifactContent({ title, ...props }: Props) {
  return isHtmlDocument(props.content) ? (
    <ArtifactHtmlFrame content={props.content} title={title} />
  ) : (
    <ArtifactMarkdown {...props} />
  );
}
