import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

// Same constraint as React.lazy.
type AnyComponent = ComponentType<any>;

export type PreloadableComponent<T extends AnyComponent> = LazyExoticComponent<T> & {
  preload: () => Promise<{ default: T }>;
};

/**
 * React.lazy whose chunk can be warmed ahead of render (hover, idle). The
 * import runs once; a failed import resets so a later preload or render retries.
 */
export function lazyWithPreload<T extends AnyComponent>(
  factory: () => Promise<{ default: T }>,
): PreloadableComponent<T> {
  let loading: Promise<{ default: T }> | null = null;
  const load = () => {
    loading ??= factory().catch((error: unknown) => {
      loading = null;
      throw error;
    });
    return loading;
  };
  const Component = lazy(load) as PreloadableComponent<T>;
  Component.preload = load;
  return Component;
}
