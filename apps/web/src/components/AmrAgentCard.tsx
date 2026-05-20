import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchVelaLoginStatus,
  startVelaLogin,
  velaLogout,
  type VelaLoginStatus,
} from '../providers/daemon';
import { useI18n } from '../i18n';
import { AgentIcon } from './AgentIcon';

interface AmrAgentCardProps {
  agentName: string;
  agentVersion: string | null | undefined;
  agentPath: string | null | undefined;
  active: boolean;
  onSelect: () => void;
}

const POLL_INTERVAL_MS = 2000;
const POLL_DURATION_MS = 5 * 60 * 1000;

// AMR (vela) agent card with right-side login button. Diverges from the
// generic `<button>` agent card because we need an interactive sub-control
// (Login / Logout) inside the row, and nested `<button>` elements are not
// valid HTML. The select-the-agent click target is therefore a div with
// keyboard handlers instead of a real button.
//
// Login flow: clicking "Login" POSTs /api/integrations/vela/login on the
// daemon. The daemon spawns `vela login`, which opens the user's browser to
// the device-authorization page (vela CLI handles the URL/code + browser
// open itself — see apps/cli/internal/commands/login.go in nexu-io/vela).
// We then poll /api/integrations/vela/status every few seconds until the
// CLI subprocess writes ~/.vela/config.json and the daemon reports
// loggedIn=true.
export function AmrAgentCard({
  agentName,
  agentVersion,
  agentPath,
  active,
  onSelect,
}: AmrAgentCardProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<VelaLoginStatus | null>(null);
  const [pending, setPending] = useState<null | 'login' | 'logout'>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hoverLogout, setHoverLogout] = useState(false);
  const pollRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const refresh = useCallback(async () => {
    const next = await fetchVelaLoginStatus();
    if (next) setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    void refresh();
    return () => stopPolling();
  }, [refresh, stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    const startedAt = Date.now();
    const tick = async () => {
      const next = await refresh();
      if (next?.loggedIn) {
        stopPolling();
        setPending(null);
        return;
      }
      if (Date.now() - startedAt > POLL_DURATION_MS) {
        stopPolling();
        setPending(null);
      }
    };
    pollRef.current = window.setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
  }, [refresh, stopPolling]);

  const handleLogin = useCallback(async () => {
    setErrorMessage(null);
    setPending('login');
    const result = await startVelaLogin();
    if (!result.ok && !result.alreadyRunning) {
      setPending(null);
      setErrorMessage(result.error || 'vela login failed');
      return;
    }
    startPolling();
  }, [startPolling]);

  const handleLogout = useCallback(async () => {
    setErrorMessage(null);
    setPending('logout');
    const result = await velaLogout();
    setPending(null);
    if (!result.ok) {
      setErrorMessage('logout failed');
      return;
    }
    await refresh();
  }, [refresh]);

  const onKeyDownSelect = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      onSelect();
    }
  };

  const stop = (event: React.MouseEvent | React.KeyboardEvent) => {
    event.stopPropagation();
  };

  const loggedIn = status?.loggedIn === true;
  const userEmail = status?.user?.email ?? '';
  const userPlan = status?.user?.plan ?? '';
  const loginInFlight = pending === 'login';
  const logoutInFlight = pending === 'logout';

  return (
    <div
      className={'agent-card amr-agent-card' + (active ? ' active' : '')}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={onSelect}
      onKeyDown={onKeyDownSelect}
    >
      <AgentIcon id="amr" size={32} />
      <div className="agent-card-body">
        <div className="agent-card-name">{agentName}</div>
        <div className="agent-card-meta">
          {loggedIn ? (
            <span title={userEmail}>
              {userPlan
                ? t('settings.amrLoggedInWithPlan', {
                    email: userEmail,
                    plan: userPlan,
                  })
                : t('settings.amrLoggedInAs', { email: userEmail })}
            </span>
          ) : agentVersion ? (
            <span title={agentPath ?? ''}>{agentVersion}</span>
          ) : (
            <span title={agentPath ?? ''}>{t('settings.amrNotLoggedIn')}</span>
          )}
        </div>
        {errorMessage ? (
          <div className="agent-card-meta amr-agent-card-error" role="alert">
            {errorMessage}
          </div>
        ) : null}
      </div>
      <div
        className="agent-card-actions amr-agent-card-actions"
        onClick={stop}
        onKeyDown={stop}
      >
        {loggedIn ? (
          <button
            type="button"
            className="agent-card-link agent-card-link--ghost amr-agent-card-status"
            onMouseEnter={() => setHoverLogout(true)}
            onMouseLeave={() => setHoverLogout(false)}
            onFocus={() => setHoverLogout(true)}
            onBlur={() => setHoverLogout(false)}
            disabled={logoutInFlight}
            onClick={(event) => {
              event.stopPropagation();
              void handleLogout();
            }}
            aria-label={t('settings.amrLogout')}
          >
            {logoutInFlight
              ? t('settings.amrLoggingOut')
              : hoverLogout
                ? t('settings.amrLogout')
                : t('settings.amrLoggedInPill')}
          </button>
        ) : (
          <button
            type="button"
            className="agent-card-link agent-card-link--ghost"
            disabled={loginInFlight}
            onClick={(event) => {
              event.stopPropagation();
              void handleLogin();
            }}
          >
            {loginInFlight
              ? t('settings.amrLoggingIn')
              : t('settings.amrLogin')}
          </button>
        )}
      </div>
      <span
        className={'status-dot' + (active ? ' active' : '')}
        aria-hidden="true"
      />
    </div>
  );
}
