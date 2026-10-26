// Optional deployment branding, set at build time through VITE_BRAND_*
// variables (see docs/getting-started/setup.md#branding). Unset, the app
// looks exactly as it does without it.

export interface Branding {
  /** Alt text for the logo and wordmark. */
  name: string;
  /** Header icon, shown when there is no wordmark. */
  logo: string;
  /** Header and sign-in wordmark (light theme). Replaces the icon when set. */
  wordmark?: string;
  /** Wordmark for the dark theme. Falls back to `wordmark`. */
  wordmarkDark?: string;
  /** Extra stylesheet loaded after the app's own CSS. */
  stylesheet?: string;
  /** Browser tab icon. */
  favicon?: string;
  /** Document title. */
  title?: string;
}

const setting = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Read at call time so tests can stub the environment. */
export const getBranding = (): Branding => {
  const env = import.meta.env;
  return {
    name: setting(env.VITE_BRAND_NAME) ?? 'AI-DLC',
    logo: setting(env.VITE_BRAND_LOGO) ?? '/logo.svg',
    wordmark: setting(env.VITE_BRAND_WORDMARK),
    wordmarkDark: setting(env.VITE_BRAND_WORDMARK_DARK),
    stylesheet: setting(env.VITE_BRAND_STYLESHEET),
    favicon: setting(env.VITE_BRAND_FAVICON),
    title: setting(env.VITE_BRAND_TITLE),
  };
};

/**
 * Apply the document-level branding before the first render: title, favicon
 * and the brand stylesheet. The stylesheet is appended after the app's CSS so
 * its rules win at equal specificity. Resolves once it loads, fails or
 * `timeoutMs` passes, so a missing file never blocks the app.
 */
export const applyBranding = (
  branding: Branding = getBranding(),
  doc: Document = document,
  timeoutMs = 3000,
): Promise<void> => {
  if (branding.title) doc.title = branding.title;
  if (branding.favicon) {
    const icon = doc.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon) {
      icon.href = branding.favicon;
      icon.removeAttribute('type');
    }
  }
  if (!branding.stylesheet) return Promise.resolve();

  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = branding.stylesheet;
  link.dataset.brand = 'true';
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
    doc.head.appendChild(link);
  });
};
