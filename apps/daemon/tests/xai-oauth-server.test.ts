import { afterEach, describe, expect, it } from 'vitest';

import {
  startCallbackListener,
  type CallbackListener,
  type CallbackOutcome,
} from '../src/xai-oauth-server.js';

// Use port 0 in tests so the OS picks a free ephemeral port — avoids
// collisions with a real Hermes / OD OAuth flow that may already own
// 127.0.0.1:56121.
const TEST_PORT = 0;

describe('startCallbackListener', () => {
  let listener: CallbackListener | null = null;

  afterEach(async () => {
    if (listener) {
      await listener.stop().catch(() => {});
      listener = null;
    }
  });

  async function fetchCallback(
    addr: { host: string; port: number },
    qs: Record<string, string>,
    pathOverride?: string,
  ): Promise<{ status: number; body: string }> {
    const path = pathOverride ?? '/callback';
    const url = new URL(`http://${addr.host}:${addr.port}${path}`);
    for (const [k, v] of Object.entries(qs)) {
      url.searchParams.set(k, v);
    }
    const r = await fetch(url);
    return { status: r.status, body: await r.text() };
  }

  it('binds and reports the actual address', async () => {
    listener = await startCallbackListener({
      expectedState: 'unused',
      onCallback: async () => {},
      port: TEST_PORT,
    });
    expect(listener.address.port).toBeGreaterThan(0);
    expect(listener.address.host).toBe('127.0.0.1');
  });

  it('invokes onCallback with kind=ok when code+state match', async () => {
    let outcome: CallbackOutcome | null = null;
    listener = await startCallbackListener({
      expectedState: 'state-abc',
      onCallback: async (o) => {
        outcome = o;
      },
      port: TEST_PORT,
    });

    const res = await fetchCallback(listener.address, {
      code: 'auth-code-1',
      state: 'state-abc',
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('Authorized');
    // onCallback runs after the response; wait a tick for async resolution.
    await new Promise((r) => setTimeout(r, 30));
    expect(outcome).toEqual({
      kind: 'ok',
      code: 'auth-code-1',
      state: 'state-abc',
    });
  });

  it('rejects state mismatch with kind=error', async () => {
    let outcome: CallbackOutcome | null = null;
    listener = await startCallbackListener({
      expectedState: 'state-abc',
      onCallback: async (o) => {
        outcome = o;
      },
      port: TEST_PORT,
    });
    const res = await fetchCallback(listener.address, {
      code: 'whatever',
      state: 'state-mismatch',
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain('Sign-in failed');
    await new Promise((r) => setTimeout(r, 30));
    expect(outcome?.kind).toBe('error');
    if (outcome?.kind === 'error') {
      expect(outcome.error).toMatch(/state mismatch/);
    }
  });

  it('surfaces an explicit ?error= param', async () => {
    let outcome: CallbackOutcome | null = null;
    listener = await startCallbackListener({
      expectedState: 'unused',
      onCallback: async (o) => {
        outcome = o;
      },
      port: TEST_PORT,
    });
    const res = await fetchCallback(listener.address, {
      error: 'access_denied',
    });
    expect(res.status).toBe(400);
    await new Promise((r) => setTimeout(r, 30));
    expect(outcome?.kind).toBe('error');
    if (outcome?.kind === 'error') {
      expect(outcome.error).toBe('access_denied');
    }
  });

  it('returns 404 for non-callback paths without consuming the listener', async () => {
    let outcomes = 0;
    listener = await startCallbackListener({
      expectedState: 'state-real',
      onCallback: async () => {
        outcomes += 1;
      },
      port: TEST_PORT,
    });

    // Browser-fetched favicon should be ignored.
    const fav = await fetchCallback(listener.address, {}, '/favicon.ico');
    expect(fav.status).toBe(404);

    // The real callback must still work afterward.
    const real = await fetchCallback(listener.address, {
      code: 'c',
      state: 'state-real',
    });
    expect(real.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(outcomes).toBe(1);
  });

  it('only consumes the first matching callback', async () => {
    let outcomes = 0;
    listener = await startCallbackListener({
      expectedState: 'state-once',
      onCallback: async () => {
        outcomes += 1;
      },
      port: TEST_PORT,
    });

    const first = await fetchCallback(listener.address, {
      code: 'c1',
      state: 'state-once',
    });
    expect(first.status).toBe(200);

    // Second hit either races the close or returns 410 / connection
    // refused — we just assert outcomes stays at 1.
    await new Promise((r) => setTimeout(r, 60));
    await fetchCallback(listener.address, {
      code: 'c2',
      state: 'state-once',
    }).catch(() => {});
    expect(outcomes).toBe(1);
  });

  it('throws a friendly EADDRINUSE error when the port is busy', async () => {
    const first = await startCallbackListener({
      expectedState: 'a',
      onCallback: async () => {},
      port: TEST_PORT,
    });
    try {
      // Try to bind a second listener to the same port the first one
      // ended up on. This must throw with a descriptive message.
      await expect(
        startCallbackListener({
          expectedState: 'b',
          onCallback: async () => {},
          port: first.address.port,
        }),
      ).rejects.toThrow(/already in use/i);
    } finally {
      await first.stop().catch(() => {});
    }
  });

  it('fires onCallback with a timeout error when nobody redirects in time', async () => {
    let outcome: CallbackOutcome | null = null;
    listener = await startCallbackListener({
      expectedState: 'state-slow',
      onCallback: async (o) => {
        outcome = o;
      },
      port: TEST_PORT,
      timeoutMs: 50,
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(outcome?.kind).toBe('error');
    if (outcome?.kind === 'error') {
      expect(outcome.error).toMatch(/timed out/i);
    }
    listener = null; // already self-closed
  });

  it('stop() closes the listener early', async () => {
    listener = await startCallbackListener({
      expectedState: 'whatever',
      onCallback: async () => {},
      port: TEST_PORT,
    });
    const port = listener.address.port;
    await listener.stop();
    listener = null;
    // Trying to fetch after close should fail at the network layer.
    await expect(
      fetch(`http://127.0.0.1:${port}/callback`).then((r) => r.text()),
    ).rejects.toBeDefined();
  });
});
