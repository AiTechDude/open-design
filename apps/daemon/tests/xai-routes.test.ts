import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the one-shot listener so tests don't actually bind 127.0.0.1:56121
// and don't race each other. The real listener is covered by
// xai-oauth-server.test.ts. Tests below only need to assert routes
// behaviour: starting the dance, exposing status, wiping tokens.
const { onCallbackHolder, stopMock, startMock } = vi.hoisted(() => {
  const holder: {
    current: ((outcome: any) => Promise<void> | void) | null;
  } = { current: null };
  const stop = vi.fn(async () => {});
  const start = vi.fn(async (input: any) => {
    holder.current = input.onCallback;
    return {
      address: { host: '127.0.0.1', port: 56121 },
      stop,
    };
  });
  return { onCallbackHolder: holder, stopMock: stop, startMock: start };
});

vi.mock('../src/xai-oauth-server.js', () => ({
  XAI_CALLBACK_HOST: '127.0.0.1',
  XAI_CALLBACK_PORT: 56121,
  XAI_CALLBACK_PATH: '/callback',
  startCallbackListener: startMock,
}));

import { registerXaiRoutes } from '../src/xai-routes.js';
import {
  XAI_OAUTH_AUTHORIZATION_ENDPOINT,
  XAI_OAUTH_TOKEN_ENDPOINT,
} from '../src/xai-oauth.js';

interface TestApp {
  baseUrl: string;
  close(): Promise<void>;
}

async function startTestApp(projectRoot: string): Promise<TestApp> {
  const app = express();
  app.use(express.json());

  const resolvedPortRef = { current: 0 };
  const httpDeps = {
    createSseResponse: () => undefined,
    isLocalSameOrigin: () => true,
    requireLocalDaemonRequest: () => true,
    resolvedPortRef,
    sendApiError: () => undefined,
    sendLiveArtifactRouteError: () => undefined,
    sendMulterError: () => undefined,
  };
  const pathDeps = {
    ARTIFACTS_DIR: '',
    BUNDLED_PETS_DIR: '',
    DESIGN_SYSTEMS_DIR: '',
    DESIGN_TEMPLATES_DIR: '',
    OD_BIN: '',
    PROJECT_ROOT: projectRoot,
    PROJECTS_DIR: '',
    PROMPT_TEMPLATES_DIR: '',
    RUNTIME_DATA_DIR: '',
    RUNTIME_DATA_DIR_CANONICAL: '',
    SKILLS_DIR: '',
    USER_DESIGN_SYSTEMS_DIR: '',
    USER_DESIGN_TEMPLATES_DIR: '',
    USER_SKILLS_DIR: '',
  };

  registerXaiRoutes(app, {
    http: httpDeps as any,
    paths: pathDeps as any,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const addr = server.address() as AddressInfo;
  resolvedPortRef.current = addr.port;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe('xai-routes', () => {
  let projectRoot: string;
  let app: TestApp;
  const realFetch = globalThis.fetch;
  const originalMediaConfigDir = process.env.OD_MEDIA_CONFIG_DIR;
  const originalDataDir = process.env.OD_DATA_DIR;

  beforeEach(async () => {
    projectRoot = await mkdtemp(path.join(tmpdir(), 'od-xai-routes-'));
    delete process.env.OD_MEDIA_CONFIG_DIR;
    delete process.env.OD_DATA_DIR;
    onCallbackHolder.current = null;
    startMock.mockClear();
    stopMock.mockClear();
    app = await startTestApp(projectRoot);
  });

  afterEach(async () => {
    await app.close();
    globalThis.fetch = realFetch;
    if (originalMediaConfigDir == null) delete process.env.OD_MEDIA_CONFIG_DIR;
    else process.env.OD_MEDIA_CONFIG_DIR = originalMediaConfigDir;
    if (originalDataDir == null) delete process.env.OD_DATA_DIR;
    else process.env.OD_DATA_DIR = originalDataDir;
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('POST /api/xai/oauth/start mints an authorize URL and opens a callback listener', async () => {
    const r = await fetch(`${app.baseUrl}/api/xai/oauth/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.authorizeUrl).toContain(XAI_OAUTH_AUTHORIZATION_ENDPOINT);
    expect(body.state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.callback).toEqual({ host: '127.0.0.1', port: 56121 });
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(startMock.mock.calls[0]![0].expectedState).toBe(body.state);
  });

  it('starting twice replaces the in-flight listener', async () => {
    await fetch(`${app.baseUrl}/api/xai/oauth/start`, { method: 'POST' });
    await fetch(`${app.baseUrl}/api/xai/oauth/start`, { method: 'POST' });
    // Second call must have stopped the first listener before opening a new one.
    expect(stopMock).toHaveBeenCalled();
    expect(startMock).toHaveBeenCalledTimes(2);
  });

  it('GET /api/xai/auth/status returns connected:false when no token is stored', async () => {
    const r = await fetch(`${app.baseUrl}/api/xai/auth/status`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ connected: false, listening: false });
  });

  it('GET /api/xai/auth/status reflects an in-flight listener', async () => {
    await fetch(`${app.baseUrl}/api/xai/oauth/start`, { method: 'POST' });
    const r = await fetch(`${app.baseUrl}/api/xai/auth/status`);
    const body = await r.json();
    expect(body.connected).toBe(false);
    expect(body.listening).toBe(true);
  });

  it('callback success path stores a token and clears the listener', async () => {
    // Start the OAuth flow.
    const startResp = await fetch(`${app.baseUrl}/api/xai/oauth/start`, {
      method: 'POST',
    });
    const { state } = await startResp.json();

    // Stub the xAI token endpoint that completeXAIAuth will hit.
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === XAI_OAUTH_TOKEN_ENDPOINT) {
        return new Response(
          JSON.stringify({
            access_token: 'fresh-bearer',
            refresh_token: 'rt-1',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'openid profile',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // Pass-through anything else (status check uses fetch too via real fetch).
      return realFetch(input, init);
    }) as typeof fetch;

    // Fire the mocked callback as if the browser had returned.
    expect(onCallbackHolder.current).toBeTruthy();
    await onCallbackHolder.current!({ kind: 'ok', code: 'auth-code', state });

    // Status should now report connected.
    const statusResp = await fetch(`${app.baseUrl}/api/xai/auth/status`);
    const status = await statusResp.json();
    expect(status.connected).toBe(true);
    expect(status.scope).toBe('openid profile');
    expect(status.listening).toBe(false); // listener cleared after handleCallback
    expect(typeof status.expiresAt).toBe('number');
  });

  it('callback error path does not store a token', async () => {
    await fetch(`${app.baseUrl}/api/xai/oauth/start`, { method: 'POST' });
    expect(onCallbackHolder.current).toBeTruthy();
    await onCallbackHolder.current!({
      kind: 'error',
      error: 'access_denied',
    });
    const status = await fetch(`${app.baseUrl}/api/xai/auth/status`).then(
      (r) => r.json(),
    );
    expect(status.connected).toBe(false);
  });

  it('POST /api/xai/oauth/disconnect wipes a stored token', async () => {
    const startResp = await fetch(`${app.baseUrl}/api/xai/oauth/start`, {
      method: 'POST',
    });
    const { state } = await startResp.json();

    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === XAI_OAUTH_TOKEN_ENDPOINT) {
        return new Response(
          JSON.stringify({
            access_token: 'fresh-bearer',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return realFetch(input, init);
    }) as typeof fetch;

    await onCallbackHolder.current!({ kind: 'ok', code: 'c', state });
    let status = await fetch(`${app.baseUrl}/api/xai/auth/status`).then((r) =>
      r.json(),
    );
    expect(status.connected).toBe(true);

    const r = await fetch(`${app.baseUrl}/api/xai/oauth/disconnect`, {
      method: 'POST',
    });
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);

    status = await fetch(`${app.baseUrl}/api/xai/auth/status`).then((r) =>
      r.json(),
    );
    expect(status.connected).toBe(false);
  });
});

describe('xai-routes — cross-origin guard', () => {
  let projectRoot: string;
  let app: TestApp;

  beforeEach(async () => {
    projectRoot = await mkdtemp(path.join(tmpdir(), 'od-xai-routes-co-'));
    onCallbackHolder.current = null;
    startMock.mockClear();
    stopMock.mockClear();

    const expressApp = express();
    expressApp.use(express.json());

    const resolvedPortRef = { current: 0 };
    const httpDeps = {
      createSseResponse: () => undefined,
      isLocalSameOrigin: () => false, // simulate cross-origin
      requireLocalDaemonRequest: () => false,
      resolvedPortRef,
      sendApiError: () => undefined,
      sendLiveArtifactRouteError: () => undefined,
      sendMulterError: () => undefined,
    };
    const pathDeps = { PROJECT_ROOT: projectRoot } as any;

    registerXaiRoutes(expressApp, {
      http: httpDeps as any,
      paths: pathDeps,
    });

    const server = http.createServer(expressApp);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const addr = server.address() as AddressInfo;
    resolvedPortRef.current = addr.port;
    app = {
      baseUrl: `http://127.0.0.1:${addr.port}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    };
  });

  afterEach(async () => {
    await app.close();
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('rejects all three endpoints when isLocalSameOrigin is false', async () => {
    for (const [method, path] of [
      ['POST', '/api/xai/oauth/start'],
      ['GET', '/api/xai/auth/status'],
      ['POST', '/api/xai/oauth/disconnect'],
    ]) {
      const r = await fetch(`${app.baseUrl}${path}`, { method });
      expect(r.status).toBe(403);
      expect((await r.json()).error).toMatch(/cross-origin/);
    }
    expect(startMock).not.toHaveBeenCalled();
  });
});
