import { useCallback, useEffect, useRef, useState } from 'react';
import { SearchPage } from './SearchPage';
import { DownloadsManager } from './DownloadsManager';
import { NetworksPage } from './NetworksPage';
import { Icon } from './Icon';
import { apiGet, apiPost, formatSpeed } from './lib';

const routeFromPath = () => {
  const p = window.location.pathname.replace(/\/+$/, '') || '/';
  const h = window.location.hash.replace(/^#\/?/, '').split(/[?&]/)[0];
  if (p === '/downloads' || (p === '/' && h === 'downloads')) return 'downloads';
  if (p === '/networks' || (p === '/' && h === 'networks')) return 'networks';
  return 'search';
};

function App() {
  const [route, setRoute] = useState(routeFromPath);
  const [torrents, setTorrents] = useState([]);
  const [backendUp, setBackendUp] = useState(true);
  const [backendError, setBackendError] = useState('');
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const polling = useRef(null);
  const mainRef = useRef(null);
  const previousRoute = useRef(route);

  const refreshTorrents = useCallback(function refresh() {
    const session = polling.current;
    if (!session?.active) return Promise.resolve();
    clearTimeout(session.timer);
    if (session.promise) {
      // A refresh after a mutation must run after the current snapshot finishes.
      session.queued = true;
      return session.promise;
    }
    session.promise = (async () => {
      do {
        session.queued = false;
        session.controller = new AbortController();
        try {
          const list = await apiGet('/torrents', { signal: session.controller.signal, timeoutMs: 10000 });
          if (!Array.isArray(list) || list.some((t) => !t || typeof t !== 'object' ||
            typeof t.infoHash !== 'string' || typeof t.name !== 'string')) {
            throw new Error('Invalid downloads response');
          }
          if (session.active && !session.queued) {
            setTorrents(list);
            setBackendUp(true);
            setBackendError('');
          }
        } catch (error) {
          if (session.active && !session.queued) {
            setBackendUp(false);
            setBackendError(error instanceof Error ? error.message : 'Request failed');
          }
        }
      } while (session.active && session.queued);
    })().finally(() => {
      session.promise = null;
      if (session.active) session.timer = setTimeout(refresh, 1500);
    });
    return session.promise;
  }, []);

  useEffect(() => {
    const session = { active: true, queued: false, promise: null, controller: null, timer: null };
    polling.current = session;
    refreshTorrents();
    return () => {
      session.active = false;
      session.controller?.abort();
      clearTimeout(session.timer);
      clearTimeout(toastTimer.current);
    };
  }, [refreshTorrents]);

  useEffect(() => {
    const onPop = () => setRoute(routeFromPath());
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('hashchange', onPop);
    };
  }, []);

  useEffect(() => {
    document.title =
      route === 'downloads'
        ? 'Downloads · Svorrent'
        : route === 'networks'
        ? 'Networks · Svorrent'
        : 'Svorrent';
    if (previousRoute.current !== route) mainRef.current?.focus();
    previousRoute.current = route;
  }, [route]);

  const navigate = (next) => {
    if (next === route) return;
    const path = next === 'downloads' ? '/downloads' : next === 'networks' ? '/networks' : '/';
    window.history.pushState(null, '', path);
    setRoute(next);
  };

  const followRoute = (event, next) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(next);
  };

  const notify = useCallback((message, tone = 'default') => {
    if (!polling.current?.active) return;
    clearTimeout(toastTimer.current);
    setToast({ message, tone, key: Date.now() });
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const downloads = torrents;
  const active = downloads.filter((t) => !t.done && !t.paused).length;
  const speed = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const down = downloads.reduce((sum, t) => sum + speed(t.downloadSpeed), 0);
  const up = downloads.reduce((sum, t) => sum + speed(t.uploadSpeed), 0);

  const [searchTerm, setSearchTerm] = useState('');
  const [repoUpdate, setRepoUpdate] = useState(null);
  const [dismissedCommit, setDismissedCommit] = useState(null);
  const [applyingRepoUpdate, setApplyingRepoUpdate] = useState(false);

  useEffect(() => {
    let active = true;
    const pollUpdater = async () => {
      try {
        const status = await apiGet('/updater/status');
        if (active && status && typeof status === 'object') {
          setRepoUpdate(status);
        }
      } catch {}
    };
    pollUpdater();
    const isBusy = repoUpdate?.status === 'checking' || repoUpdate?.status === 'available' || repoUpdate?.status === 'downloading' || applyingRepoUpdate;
    const timer = setInterval(pollUpdater, isBusy ? 1500 : 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [repoUpdate?.status, applyingRepoUpdate]);

  const handleApplyRepoUpdate = async () => {
    if (applyingRepoUpdate) return;
    setApplyingRepoUpdate(true);
    notify('Integrating verified repository code and restarting…');
    try {
      await apiPost('/updater/restart');
      setTimeout(() => {
        setApplyingRepoUpdate(false);
        apiGet('/updater/status').then(setRepoUpdate).catch(() => {});
      }, 3000);
    } catch (err) {
      notify(err.message || 'Failed to apply update', 'error');
      setApplyingRepoUpdate(false);
    }
  };

  const handleGoSearch = (term) => {
    if (typeof term === 'string') setSearchTerm(term);
    navigate('search');
  };

  const showUpdatePrompt = !!(
    repoUpdate &&
    (repoUpdate.updateAvailable || repoUpdate.readyToInstall) &&
    (repoUpdate.latestCommit || repoUpdate.latestVersion) !== dismissedCommit
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <a
            href="/"
            className="wordmark"
            onClick={(e) => followRoute(e, 'search')}
          >
            <img src="/favicon.svg" alt="" className="brand-logo" width="20" height="20" />
            <span>svorrent</span>
          </a>

          <nav className="tabs" aria-label="Primary">
            <a
              id="nav-search"
              href="/"
              aria-current={route === 'search' ? 'page' : undefined}
              className={`tab ${route === 'search' ? 'is-active' : ''}`}
              onClick={(e) => followRoute(e, 'search')}
            >
              Search
            </a>
            <a
              id="nav-downloads"
              href="/downloads"
              aria-current={route === 'downloads' ? 'page' : undefined}
              className={`tab ${route === 'downloads' ? 'is-active' : ''}`}
              onClick={(e) => followRoute(e, 'downloads')}
            >
              Downloads
              {downloads.length > 0 && <span className="tab-count">{downloads.length}</span>}
            </a>
            <a
              id="nav-networks"
              href="/networks"
              aria-current={route === 'networks' ? 'page' : undefined}
              className={`tab ${route === 'networks' ? 'is-active' : ''}`}
              onClick={(e) => followRoute(e, 'networks')}
            >
              Networks
            </a>
          </nav>

          <div className="topbar-status">
            {!backendUp ? (
              <span className="status-offline" role="status" title={backendError}>
                Backend unavailable{backendError ? `: ${backendError}` : ''}
              </span>
            ) : (
              <>
                <span className="rate" title="Total download rate">
                  <Icon name="arrowDown" size={12} />
                  {formatSpeed(down)}
                </span>
                <span className="rate" title="Total upload rate">
                  <Icon name="arrowUp" size={12} />
                  {formatSpeed(up)}
                </span>
                {active > 0 && <span className="rate-meta">{active} active</span>}
              </>
            )}
          </div>
        </div>
      </header>

      {showUpdatePrompt && (
        <div className="repo-update-banner" role="region" aria-label="Repository code update">
          <div className="repo-update-inner">
            <div className="repo-update-info">
              <span className="repo-update-badge">
                {repoUpdate.readyToInstall ? 'NEW CODE VERIFIED' : 'INTEGRATING REPO CODE'}
              </span>
              <span className="repo-update-text">
                {repoUpdate.readyToInstall
                  ? `Commit ${repoUpdate.latestCommit ? repoUpdate.latestCommit.slice(0, 7) : repoUpdate.latestVersion} passed self-tests and is ready to integrate`
                  : repoUpdate.step || `Integrating ${repoUpdate.latestVersion} (${repoUpdate.downloadProgress || 0}%)…`}
              </span>
              {repoUpdate.commitMessage && (
                <span className="repo-update-commit muted">
                  — “{repoUpdate.commitMessage}”
                </span>
              )}
            </div>
            <div className="repo-update-actions">
              {repoUpdate.readyToInstall ? (
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleApplyRepoUpdate}
                  disabled={applyingRepoUpdate}
                >
                  <Icon name="refresh" size={12} className={applyingRepoUpdate ? 'spin' : ''} />
                  <span>{applyingRepoUpdate ? 'Applying…' : 'Integrate & Restart'}</span>
                </button>
              ) : (
                <span className="repo-update-progress mono">
                  {repoUpdate.downloadProgress || 0}%
                </span>
              )}
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setDismissedCommit(repoUpdate.latestCommit || repoUpdate.latestVersion)}
                aria-label="Dismiss update prompt"
              >
                Later
              </button>
            </div>
          </div>
        </div>
      )}

      <main
        className="page"
        ref={mainRef}
        tabIndex={-1}
        style={{ outline: 'none' }}
        aria-label={route === 'search' ? 'Search' : route === 'downloads' ? 'Downloads' : 'Networks'}
      >
        <div style={{ display: route === 'search' ? 'block' : 'none' }}>
          <SearchPage initialQuery={searchTerm} isActive={route === 'search'} notify={notify} onDownloadAdded={refreshTorrents} />
        </div>
        <div style={{ display: route === 'downloads' ? 'block' : 'none' }}>
          <DownloadsManager
            torrents={downloads}
            setTorrents={setTorrents}
            refresh={refreshTorrents}
            notify={notify}
            onGoSearch={handleGoSearch}
          />
        </div>
        <div style={{ display: route === 'networks' ? 'block' : 'none' }}>
          <NetworksPage notify={notify} isActive={route === 'networks'} />
        </div>
      </main>

      {toast && (
        <div key={toast.key} className={`toast toast-${toast.tone}`} role="status">
          {toast.message}
        </div>
      )}


    </div>
  );
}

export default App;
