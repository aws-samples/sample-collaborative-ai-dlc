import { getBranding } from '@/lib/branding';
import { cn } from '@/lib/utils';

interface Props {
  /** Height classes for the wordmark, e.g. "h-5". */
  wordmarkClassName: string;
  /** Rendered when the deployment sets no wordmark. */
  fallback: React.ReactNode;
  /**
   * The brand name is already visible as text next to the mark, so the images
   * carry no alt text (otherwise the name is announced twice).
   */
  decorative?: boolean;
}

/** The deployment's wordmark (light and dark), or the fallback. */
export function BrandMark({ wordmarkClassName, fallback, decorative = false }: Props) {
  const { name, wordmark, wordmarkDark } = getBranding();
  if (!wordmark) return <>{fallback}</>;
  const alt = decorative ? '' : name;
  return (
    <>
      <img src={wordmark} alt={alt} className={cn(wordmarkClassName, 'w-auto dark:hidden')} />
      <img
        src={wordmarkDark ?? wordmark}
        alt={alt}
        className={cn(wordmarkClassName, 'hidden w-auto dark:block')}
      />
    </>
  );
}
