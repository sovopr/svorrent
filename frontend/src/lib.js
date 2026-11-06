export const API = '/api';

async function request(path, init, { signal, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timedOut = false;
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(`${API}${path}`, { ...init, signal: controller.signal });
    let data;
    try {
      data = res.status === 204 ? {} : await res.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error(res.ok ? 'The server returned an invalid response.' : `Request failed (${res.status})`);
    }
    controller.signal.throwIfAborted();
    if (!res.ok) {
      throw new Error(typeof data?.error === 'string' ? data.error : `Request failed (${res.status})`);
    }
    if (!data || typeof data !== 'object') throw new Error('The server returned an invalid response.');
    if (typeof data.error === 'string' && data.error) throw new Error(data.error);
    if (data.success === false) throw new Error('The server could not complete the request.');
    return data;
  } catch (error) {
    if (timedOut) throw new Error('The request timed out. Please try again.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function apiGet(path, options) {
  return request(path, {}, options);
}

export function apiPost(path, body, options) {
  return request(path, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }, options);
}


export function formatBytes(bytes) {
  bytes = Number(bytes);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1));
  const value = bytes / Math.pow(1024, i);
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatSpeed(bytes) {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return '—';
  return `${formatBytes(bytes)}/s`;
}

export function progressPercent(value) {
  const progress = Number(value);
  if (!Number.isFinite(progress)) return 0;
  return Math.round(Math.max(0, Math.min(1, progress)) * 100);
}

export function formatEta(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// Converts strings like "1.4 GB" / "700 MiB" into bytes for sorting.
export function parseSize(str) {
  if (!str) return 0;
  const match = String(str).replace(/,/g, '').match(/([\d.]+)\s*([KMGT]?)i?B/i);
  if (!match) return 0;
  const power = { '': 0, K: 1, M: 2, G: 3, T: 4 }[match[2].toUpperCase()] ?? 0;
  const bytes = Number(match[1]) * Math.pow(1024, power);
  return Number.isFinite(bytes) ? bytes : 0;
}

export function formatDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '—';
  const now = new Date();
  const diffDays = Math.floor((now - d) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) {
    return `Today, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  if (diffDays === 1) {
    return `Yesterday, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

export function formatPeerAddress(ip, port) {
  if (!ip) return '—';
  const str = String(ip).trim();
  const formattedIp = str.includes(':') && !str.startsWith('[') ? `[${str}]` : str;
  return port ? `${formattedIp}:${port}` : formattedIp;
}

export function getPageNumbers(currentPage, totalPages) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  if (currentPage <= 4) {
    return [1, 2, 3, 4, 5, '...', totalPages];
  }
  if (currentPage >= totalPages - 3) {
    return [1, '...', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }
  return [1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages];
}
