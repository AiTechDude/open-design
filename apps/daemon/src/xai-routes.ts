// Daemon-owned routes for the xAI OAuth flow.
//
// Mirrors apps/daemon/src/mcp-routes.ts in shape, but the callback path
// has to be different: xAI's PoC client_id locks the redirect_uri to
// http://127.0.0.1:56121/callback (Hermes-issued), so we run a one-shot
// loopback listener (xai-oauth-server.ts) for the redirect instead of
// piggybacking on the daemon's main HTTP port. Once Open Design owns
// its own xAI client_id, this file shrinks back to the daemon-port
// shape that mcp-routes.ts uses.
//
// Endpoints:
//   POST /api/xai/oauth/start       — mint PKCE state, open :56121
//                                     listener, return authorize URL
//   GET  /api/xai/auth/status       — has-token / expiry / in-flight bit
//   POST /api/xai/oauth/disconnect  — wipe stored token, stop listener

import type { Express } from 'express';

import { mediaConfigDir } from './media-config.js';
import { PendingAuthCache } from './mcp-oauth.js';
import { beginXAIAuth, completeXAIAuth } from './xai-oauth.js';
import {
  startCallbackListener,
  type CallbackListener,
  type CallbackOutcome,
} from './xai-oauth-server.js';
import {
  clearXAIToken,
  getXAIToken,
  setXAIToken,
  type StoredXAIToken,
} from './xai-tokens.js';
import type { RouteDeps } from './server-context.js';

export interface RegisterXaiRoutesDeps extends RouteDeps<'http' | 'paths'> {}

export function registerXaiRoutes(app: Express, ctx: RegisterXaiRoutesDeps) {
  const { isLocalSameOrigin, resolvedPortRef } = ctx.http;
  const { PROJECT_ROOT } = ctx.paths;
  const getResolvedPort = () => resolvedPortRef.current;

  const pendingAuth = new PendingAuthCache();
  let activeListener: CallbackListener | null = null;

  const stopActiveListener = async () => {
    const cur = activeListener;
    activeListener = null;
    if (!cur) return;
    try {
      await cur.stop();
    } catch {
      // Best-effort; the listener self-closes on completion / timeout
      // anyway.
    }
  };

  const handleCallback = async (outcome: CallbackOutcome): Promise<void> => {
    activeListener = null;
    if (outcome.kind !== 'ok') {
      console.warn(`[xai-oauth] callback failed: ${outcome.error}`);
      return;
    }
    try {
      const tokenResp = await completeXAIAuth({
        pending: pendingAuth,
        state: outcome.state,
        code: outcome.code,
      });
      const stored: StoredXAIToken = {
        accessToken: tokenResp.access_token,
        tokenType: tokenResp.token_type ?? 'Bearer',
        savedAt: Date.now(),
      };
      if (tokenResp.refresh_token) stored.refreshToken = tokenResp.refresh_token;
      if (tokenResp.scope) stored.scope = tokenResp.scope;
      if (typeof tokenResp.expires_in === 'number') {
        stored.expiresAt = Date.now() + tokenResp.expires_in * 1000;
      }
      await setXAIToken(mediaConfigDir(PROJECT_ROOT), stored);
      console.log('[xai-oauth] token stored');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[xai-oauth] token exchange failed:', msg);
    }
  };

  app.post('/api/xai/oauth/start', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    // Only one OAuth dance can be in flight at a time — :56121 is
    // singleton. Stop any prior listener (e.g. user closed the browser
    // tab and clicked Sign in again) before opening a new one.
    await stopActiveListener();

    try {
      const { authorizeUrl, state } = beginXAIAuth({ pending: pendingAuth });
      // Open the one-shot listener BEFORE returning so the client can
      // navigate the browser to authorizeUrl without racing startup.
      activeListener = await startCallbackListener({
        expectedState: state,
        onCallback: handleCallback,
      });
      console.log(
        `[xai-oauth] start ok state=${state.slice(0, 8)}… listener=${activeListener.address.host}:${activeListener.address.port}`,
      );
      res.json({
        authorizeUrl,
        state,
        callback: {
          host: activeListener.address.host,
          port: activeListener.address.port,
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[xai-oauth] start failed:', msg);
      await stopActiveListener();
      res.status(502).json({ error: msg });
    }
  });

  app.get('/api/xai/auth/status', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      const tok = await getXAIToken(mediaConfigDir(PROJECT_ROOT));
      if (!tok) {
        return res.json({ connected: false, listening: activeListener !== null });
      }
      res.json({
        connected: true,
        expiresAt: tok.expiresAt ?? null,
        scope: tok.scope ?? null,
        savedAt: tok.savedAt,
        listening: activeListener !== null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/xai/oauth/disconnect', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    try {
      await stopActiveListener();
      await clearXAIToken(mediaConfigDir(PROJECT_ROOT));
      res.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });
}
