import { getBranding } from '@/lib/branding';
import { cn } from '@/lib/utils';

interface Props {
  /** Height classes for the wordmark, e.g. "h-5". */
  wordmarkClassName: string;
  /** Rendered when the deployment sets no wordmark. */
  fallback: React.ReactNode;
}

/** The deployment's wordmark (light and dark), or the fallback. */
export function BrandMark({ wordmarkClassName, fallback }: Props) {
  const { name, wordmark, wordmarkDark } = getBranding();
  if (!wordmark) return <>{fallback}</>;
  return (
    <>
      <img src={wordmark} alt={name} className={cn(wordmarkClassName, 'w-auto dark:hidden')} />
      <img
        src={wordmarkDark ?? wordmark}
        alt={name}
        className={cn(wordmarkClassName, 'hidden w-auto dark:block')}
      />
    </>
  );
}
