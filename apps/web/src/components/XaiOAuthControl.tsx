// xAI / SuperGrok OAuth control rendered inside the Grok provider row in
// the Settings → Media Providers panel.
//
// Mirrors the shape of McpOAuthControl in McpClientSection.tsx (state
// machine, polling cadence, CSS classes), but skips the postMessage /
// BroadcastChannel handshake because the xAI callback is served by the
// one-shot listener on 127.0.0.1:56121 — a separate process that can't
// talk to the OD UI directly. Polling /api/xai/auth/status is the only
// delivery channel for "auth completed".
//
// TODO(i18n): the visible strings are hardcoded English for the PoC;
// migrate to apps/web/src/i18n/types.ts before stable release.

'use client';

import { useEffect, useRef, useState } from 'react';

interface XaiAuthStatus {
  connected: boolean;
  listening?: boolean;
  expiresAt?: number | null;
  scope?: string | null;
  savedAt?: number;
}

interface StartResponse {
  authorizeUrl: string;
  state: string;
  callback: { host: string; port: number };
}

type Busy =
  | 'idle'
  | 'starting'
  | 'awaiting'
  | 'disconnecting'
  | 'refreshing';

async function fetchStatus(): Promise<XaiAuthStatus | null> {
  try {
    const r = await fetch('/api/xai/auth/status', { credentials: 'same-origin' });
    if (!r.ok) return null;
    return (await r.json()) as XaiAuthStatus;
  } catch {
    return null;
  }
}

async function startOAuth(): Promise<
  { ok: true; response: StartResponse } | { ok: false; message: string }
> {
  try {
    const r = await fetch('/api/xai/oauth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: '{}',
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const message =
        typeof body?.error === 'string' && body.error
          ? body.error
          : `daemon returned HTTP ${r.status}`;
      return { ok: false, message };
    }
    return { ok: true, response: body as StartResponse };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function disconnectOAuth(): Promise<boolean> {
  try {
    const r = await fetch('/api/xai/oauth/disconnect', {
      method: 'POST',
      credentials: 'same-origin',
    });
    return r.ok;
  } catch {
    return false;
  }
}

export function XaiOAuthControl() {
  const [status, setStatus] = useState<XaiAuthStatus | null>(null);
  const [busy, setBusy] = useState<Busy>('idle');
  const [error, setError] = useState<string | null>(null);
  // Authorize URL kept around as a fallback link in case the popup blocker
  // ate window.open or the user closed the tab and wants to re-open it.
  const [pendingAuthUrl, setPendingAuthUrl] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = async () => {
    const data = await fetchStatus();
    if (data) setStatus(data);
    return data;
  };

  useEffect(() => {
    void refresh();
    return () => stopPoll();
  }, []);

  function stopPoll() {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }

  function startPoll() {
    stopPoll();
    let elapsed = 0;
    pollTimer.current = setInterval(() => {
      elapsed += 2000;
      void (async () => {
        const data = await refresh();
        if (data?.connected) {
          setBusy('idle');
          setError(null);
          setPendingAuthUrl(null);
          stopPoll();
        } else if (data && !data.listening) {
          // Listener self-closed (timeout / error) — give up polling so
          // the UI doesn't sit forever on "Waiting…".
          stopPoll();
          setBusy('idle');
        }
      })();
      // Hard cap at 30 min — same as the daemon-side listener timeout.
      if (elapsed >= 30 * 60 * 1000) stopPoll();
    }, 2000);
  }

  const onConnect = async () => {
    setError(null);
    setPendingAuthUrl(null);
    setBusy('starting');
    const result = await startOAuth();
    if (!result.ok) {
      setBusy('idle');
      setError(result.message);
      return;
    }
    setBusy('awaiting');
    setPendingAuthUrl(result.response.authorizeUrl);
    startPoll();
    try {
      window.open(
        result.response.authorizeUrl,
        '_blank',
        'noopener=no,noreferrer=no',
      );
    } catch {
      // Fallback anchor is always rendered while pending.
    }
  };

  const onRefreshStatus = async () => {
    setBusy('refreshing');
    const data = await refresh();
    setBusy('idle');
    if (data?.connected) {
      setError(null);
      setPendingAuthUrl(null);
      stopPoll();
    } else if (busy === 'awaiting' || pendingAuthUrl) {
      setBusy('awaiting');
    }
  };

  const onCancelPending = () => {
    setPendingAuthUrl(null);
    setBusy('idle');
    setError(null);
    stopPoll();
  };

  const onDisconnect = async () => {
    setBusy('disconnecting');
    const ok = await disconnectOAuth();
    setBusy('idle');
    if (ok) {
      setError(null);
      setPendingAuthUrl(null);
      setStatus({ connected: false });
    } else {
      setError('Disconnect failed. Check daemon logs.');
    }
  };

  const connected = Boolean(status?.connected);
  const expiresLabel =
    status?.expiresAt && status.expiresAt > 0
      ? new Date(status.expiresAt).toLocaleString()
      : null;
  const isAwaiting = busy === 'awaiting' || (Boolean(pendingAuthUrl) && !connected);

  return (
    <div className={`mcp-oauth-control${connected ? ' connected' : ''}`}>
      <div className="mcp-oauth-status" aria-live="polite">
        {connected ? (
          <>
            <span className="mcp-oauth-dot mcp-oauth-dot-ok" aria-hidden />
            <span>
              <strong>Signed in with X.</strong>{' '}
              {expiresLabel ? (
                <span className="hint">
                  SuperGrok subscription token expires {expiresLabel}.
                </span>
              ) : (
                <span className="hint">SuperGrok subscription connected.</span>
              )}
            </span>
          </>
        ) : isAwaiting ? (
          <>
            <span className="mcp-oauth-dot mcp-oauth-dot-pending" aria-hidden />
            <span>
              <strong>Waiting for authorization…</strong>{' '}
              <span className="hint">
                Approve in the browser tab that opened. The daemon is
                listening on 127.0.0.1:56121 — if you're on a remote machine,
                forward the port with{' '}
                <code>ssh -L 56121:127.0.0.1:56121 user@host</code>.
              </span>
            </span>
          </>
        ) : (
          <>
            <span className="mcp-oauth-dot" aria-hidden />
            <span>
              <strong>Not signed in.</strong>{' '}
              <span className="hint">
                Click Sign in with X to use your SuperGrok subscription for
                Grok image, video, and TTS in Open Design — no API key
                needed.
              </span>
            </span>
          </>
        )}
      </div>

      <div className="mcp-oauth-actions">
        {connected ? (
          <>
            <button
              type="button"
              className="primary"
              onClick={onConnect}
              disabled={busy !== 'idle' && busy !== 'refreshing'}
              title="Re-authenticate (replaces the existing token)"
            >
              {busy === 'starting' || busy === 'awaiting'
                ? 'Connecting…'
                : 'Reconnect'}
            </button>
            <button
              type="button"
              onClick={onDisconnect}
              disabled={busy !== 'idle'}
            >
              {busy === 'disconnecting' ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="primary"
              onClick={onConnect}
              disabled={busy !== 'idle'}
            >
              {busy === 'starting' ? 'Opening browser…' : 'Sign in with X'}
            </button>
            {isAwaiting ? (
              <>
                <button type="button" onClick={onRefreshStatus} disabled={busy === 'refreshing'}>
                  {busy === 'refreshing' ? 'Checking…' : 'Refresh status'}
                </button>
                <button type="button" onClick={onCancelPending}>
                  Cancel
                </button>
              </>
            ) : null}
          </>
        )}
      </div>

      {pendingAuthUrl && !connected ? (
        <div className="mcp-oauth-fallback hint">
          Browser tab didn't open?{' '}
          <a href={pendingAuthUrl} target="_blank" rel="noopener noreferrer">
            Click here to open the authorize URL manually
          </a>
          .
        </div>
      ) : null}

      {error ? (
        <div className="mcp-oauth-error" role="alert">
          {error}
        </div>
      ) : null}

      {status?.scope ? (
        <div className="mcp-oauth-scope hint">
          Granted scopes: <code>{status.scope}</code>
        </div>
      ) : null}
    </div>
  );
}
