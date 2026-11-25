import { QueryClientProvider } from '@tanstack/react-query';
import {
  render as renderReact,
  renderHook as renderReactHook,
  type RenderOptions,
  type RenderHookOptions,
} from '@testing-library/react';
import type { PropsWithChildren, ReactElement } from 'react';
import { queryClient } from '@/lib/queryClient';
import { afterEach, vi } from 'vitest';

export * from '@testing-library/react';

let restoreClock: (() => void) | undefined;
export function setQueryClock(now?: () => number) {
  restoreClock?.();
  restoreClock = now ? vi.spyOn(Date, 'now').mockImplementation(now).mockRestore : undefined;
}
afterEach(() => setQueryClock());

function provider(Wrapper?: RenderOptions['wrapper']) {
  return function TestProvider({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>
        {Wrapper ? <Wrapper>{children}</Wrapper> : children}
      </QueryClientProvider>
    );
  };
}

export function render(ui: ReactElement, options: RenderOptions = {}) {
  return renderReact(ui, { ...options, wrapper: provider(options.wrapper) });
}

export function renderHook<R, P>(hook: (props: P) => R, options: RenderHookOptions<P> = {}) {
  return renderReactHook(hook, { ...options, wrapper: provider(options.wrapper) });
}
