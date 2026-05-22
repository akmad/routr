import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, vi } from 'vitest';

// @testing-library/react auto-cleans only when globals are enabled. We run
// with globals: false, so register an explicit afterEach.
afterEach(() => {
  cleanup();
});

// Mock @tanstack/react-router so page components can be rendered in isolation
// without setting up a full router. Tests assert on routing intent (the `to`
// prop or the navigate target) rather than the router's runtime behavior.
vi.mock('@tanstack/react-router', () => {
  const Link = ({
    to,
    children,
    className,
    ...rest
  }: { to: string; children: ReactNode; className?: string } & Record<string, unknown>) => {
    // Filter out the activeProps prop — it's router-specific and not a valid <a> attr.
    const { activeProps: _activeProps, ...anchorProps } = rest;
    return (
      <a href={to} className={className} data-to={to} {...anchorProps}>
        {children}
      </a>
    );
  };
  const Navigate = ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />;
  // router.tsx wires up routes at module load via createRootRoute/createRoute/
  // createRouter. Tests don't render AppRouter; we just need those helpers
  // to not throw when the module is imported.
  const makeRoute = (cfg: Record<string, unknown>) => ({
    ...cfg,
    addChildren: () => makeRoute(cfg),
  });
  return {
    Link,
    Navigate,
    Outlet: () => null,
    useNavigate: () => vi.fn(),
    RouterProvider: () => null,
    createRootRoute: (cfg: Record<string, unknown>) => makeRoute(cfg),
    createRoute: (cfg: Record<string, unknown>) => makeRoute(cfg),
    createRouter: () => ({}),
  };
});
