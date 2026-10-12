import { Component, type ReactNode } from 'react';

/**
 * Catches an unexpected failure while drawing a screen and offers a way back,
 * instead of leaving the person with a blank page.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error('The page could not be displayed:', error);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <h1 className="text-lg font-semibold text-slate-900">This page could not be displayed</h1>
        <p className="mt-2 text-sm text-slate-600">
          Reloading usually fixes it. If it keeps happening, the site and its server may be on different versions.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-6 inline-flex h-9 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
        >
          Reload
        </button>
      </div>
    );
  }
}
