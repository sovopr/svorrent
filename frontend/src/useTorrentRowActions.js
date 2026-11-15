import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, validMagnet } from './lib';

export function useTorrentRowActions({ setItems, generationRef, isActive = true, notify, onDownloadAdded }) {
  const [rowState, setRowState] = useState({});
  const mounted = useRef(false);
  const active = useRef(isActive);
  const actions = useRef(new Map());

  useEffect(() => {
    active.current = isActive;
  }, [isActive]);

  useEffect(() => {
    mounted.current = true;
    const pending = actions.current;
    return () => {
      mounted.current = false;
      for (const controller of pending.values()) controller.abort();
      pending.clear();
    };
  }, []);

  const clearRowState = useCallback(() => {
    setRowState({});
  }, []);

  const isCurrent = (t, controller) =>
    mounted.current && !controller.signal.aborted && generationRef.current === t._generation;

  const setRow = (t, controller, value) => {
    if (isCurrent(t, controller)) {
      setRowState((prev) => ({ ...prev, [t._id]: value }));
    }
  };

  const resolveMagnet = async (t, controller) => {
    if (validMagnet(t.magnet)) return t.magnet;
    const params = new URLSearchParams({
      provider: t.provider || '',
      desc: t.desc || '',
      link: t.link || '',
      title: t.title || '',
    });
    const data = await apiGet(`/magnet?${params}`, { signal: controller.signal });
    if (!validMagnet(data.magnet)) throw new Error('The server did not return a valid magnet link.');
    if (isCurrent(t, controller)) {
      setItems((prev) => prev.map((r) => (r._id === t._id ? { ...r, magnet: data.magnet } : r)));
    }
    return data.magnet;
  };

  const handleAction = async (t, action) => {
    if (actions.current.has(t._id) || (action === 'adding' && rowState[t._id] === 'added')) return;
    const controller = new AbortController();
    const previous = rowState[t._id];
    actions.current.set(t._id, controller);
    setRow(t, controller, action);
    try {
      if (action === 'adding') {
        const data = await apiPost(
          '/torrent/download',
          {
            magnet: t.magnet,
            provider: t.provider,
            desc: t.desc,
            link: t.link,
            infoHash: t.infoHash,
            title: t.title,
          },
          { signal: controller.signal },
        );
        if (data.success !== true || typeof data.infoHash !== 'string') {
          throw new Error('The server did not confirm the download. Check Downloads before retrying.');
        }
        setRow(t, controller, 'added');
        if (mounted.current && !controller.signal.aborted) {
          notify('Added to downloads.');
          onDownloadAdded?.();
        }
      } else if (action === 'opening') {
        const magnet = await resolveMagnet(t, controller);
        if (!isCurrent(t, controller) || !active.current) return;
        window.location.assign(magnet);
      }
    } catch (err) {
      setRow(t, controller, previous || null);
      if (isCurrent(t, controller)) notify(err.message || 'Could not complete the action.', 'error');
    } finally {
      if (action !== 'adding') setRow(t, controller, previous || null);
      if (actions.current.get(t._id) === controller) actions.current.delete(t._id);
    }
  };

  return { rowState, clearRowState, handleAction };
}
