// @vitest-environment jsdom

/**
 * Coverage for the AMR-specific Settings agent card. It diverges from the
 * generic `<button>` card so we can host a real interactive sub-control
 * (Login / Logout) inside the row — see AmrAgentCard.tsx for the why.
 *
 * Tests use the daemon provider's `globalThis.fetch` so we can intercept
 * /api/integrations/vela/{status,login,logout} without spinning up the real
 * daemon. The component's behaviour is otherwise pure React + i18n.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AmrAgentCard } from '../../src/components/AmrAgentCard';
import { I18nProvider } from '../../src/i18n';

interface StubbedResponse {
  status?: number;
  body: unknown;
}

function jsonResponse({ status = 200, body }: StubbedResponse): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

function renderCard(active = false) {
  const onSelect = vi.fn();
  const result = render(
    <I18nProvider initial="en">
      <AmrAgentCard
        agentName="AMR (vela)"
        agentVersion={null}
        agentPath="/usr/local/bin/vela"
        active={active}
        onSelect={onSelect}
      />
    </I18nProvider>,
  );
  return { ...result, onSelect };
}

describe('AmrAgentCard', () => {
  it('shows a Sign-in button and a "Not signed in" label when the daemon reports loggedIn=false', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          body: { loggedIn: false, profile: 'local', user: null, configPath: '/x' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    renderCard();

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByText('Not signed in')).toBeTruthy();
  });

  it('shows "Signed in" pill with the user email when logged in', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        body: {
          loggedIn: true,
          profile: 'local',
          configPath: '/x',
          user: { id: 'u', email: 'leaf@example.com', plan: 'free' },
        },
      }),
    ) as typeof fetch;

    renderCard();

    await waitFor(() => {
      expect(screen.getByText('Signed in as leaf@example.com · free')).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('selecting the row (not the sub-button) calls onSelect; clicking the Sign-in button does not select the row', async () => {
    const fetchMock = vi.fn(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          body: { loggedIn: false, profile: 'local', user: null, configPath: '/x' },
        });
      }
      if (
        url.endsWith('/api/integrations/vela/login') &&
        init?.method === 'POST'
      ) {
        return jsonResponse({ status: 202, body: { pid: 4242 } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const { onSelect } = renderCard();
    const signInBtn = await screen.findByRole('button', { name: 'Sign in' });

    // Click the inner sub-button → POSTs /login but does NOT bubble up as a
    // row-select (the wrapper has role="button" but the actions area
    // explicitly stopPropagation()s).
    fireEvent.click(signInBtn);
    expect(onSelect).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/api/integrations/vela/login') &&
            (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true);
    });

    // Clicking the row body still selects the agent (the role="button"
    // wrapper handles the click outside the actions zone).
    fireEvent.click(screen.getByText('AMR (vela)'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('logout button POSTs /logout and refreshes status to logged-out', async () => {
    let loggedIn = true;
    const fetchMock = vi.fn(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          body: loggedIn
            ? {
                loggedIn: true,
                profile: 'local',
                configPath: '/x',
                user: { id: 'u', email: 'leaf@example.com', plan: 'free' },
              }
            : { loggedIn: false, profile: 'local', user: null, configPath: '/x' },
        });
      }
      if (
        url.endsWith('/api/integrations/vela/logout') &&
        init?.method === 'POST'
      ) {
        loggedIn = false;
        return jsonResponse({ body: { ok: true } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    renderCard();
    const logoutBtn = await screen.findByRole('button', { name: 'Sign out' });
    fireEvent.click(logoutBtn);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    });
    expect(screen.getByText('Not signed in')).toBeTruthy();
  });
});
