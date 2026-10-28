// Svorrent Background Silent Auto-Updater
// Silently checks GitHub Releases (/releases/latest), verifies SHA-256 digests,
// downloads updates in the background, and applies updates on restart.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function parseSemver(versionStr) {
  if (typeof versionStr !== 'string') return [0, 0, 0];
  const clean = versionStr.replace(/^v/i, '').trim();
  const parts = clean.split('.').map((p) => {
    const num = parseInt(p, 10);
    return Number.isFinite(num) ? num : 0;
  });
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

export function isNewerVersion(currentVer, latestVer) {
  const [cMaj, cMin, cPat] = parseSemver(currentVer);
  const [lMaj, lMin, lPat] = parseSemver(latestVer);

  if (lMaj > cMaj) return true;
  if (lMaj < cMaj) return false;
  if (lMin > cMin) return true;
  if (lMin < cMin) return false;
  return lPat > cPat;
}

export class AutoUpdater {
  constructor(options = {}) {
    this.currentVersion = options.currentVersion || '1.0.4';
    this.currentCommit = options.currentCommit || null;
    this.platform = options.platform || process.platform;
    this.repo = options.repo || 'sovopr/svorrent';
    this.checkIntervalMs = options.checkIntervalMs || 6 * 60 * 60 * 1000; // 6 hours
    this.cacheDir = options.cacheDir || this.resolveCacheDir();
    this.state = {
      status: 'idle', // 'idle' | 'checking' | 'available' | 'downloading' | 'ready_to_install' | 'error'
      latestVersion: null,
      releaseNotes: '',
      releaseUrl: null,
      assetName: null,
      assetPath: null,
      assetDigest: null,
      downloadProgress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      lastChecked: null,
      error: null,
    };
    this.checkTimer = null;
    this.abortController = null;
  }

  resolveCacheDir() {
    if (this.platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Caches', 'Svorrent', 'updates');
    }
    if (this.platform === 'win32') {
      const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      return path.join(base, 'Svorrent', 'updates');
    }
    return path.join(os.homedir(), '.cache', 'svorrent', 'updates');
  }

  start() {
    fs.mkdirSync(this.cacheDir, { recursive: true });
    // Run an initial check 5 seconds after startup
    setTimeout(() => {
      this.checkForUpdates().catch(() => {});
    }, 5000);

    // Setup periodic check
    this.checkTimer = setInterval(() => {
      this.checkForUpdates().catch(() => {});
    }, this.checkIntervalMs);
  }

  stop() {
    if (this.checkTimer) clearInterval(this.checkTimer);
    if (this.abortController) this.abortController.abort();
  }

  getStatus() {
    const isNewer = this.state.latestVersion
      ? isNewerVersion(this.currentVersion, this.state.latestVersion)
      : false;
    const ready = this.state.status === 'ready_to_install' && isNewer;
    return {
      currentVersion: this.currentVersion,
      currentCommit: this.currentCommit,
      channel: 'release',
      ...this.state,
      updateAvailable: isNewer && this.state.status !== 'error',
      readyToInstall: ready,
    };
  }

  async fetchLatestReleaseFallback() {
    const webUrl = `https://github.com/${this.repo}/releases/latest`;
    const res = await fetch(webUrl, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': `Svorrent/${this.currentVersion}` },
      signal: AbortSignal.timeout(10000),
    });
    const location = res.headers.get('location') || '';
    const match = location.match(/\/releases\/tag\/([^/?#]+)/);
    if (!match) {
      throw new Error('Could not resolve latest release tag from GitHub');
    }
    const tagName = decodeURIComponent(match[1]);
    const sumsUrl = `https://github.com/${this.repo}/releases/download/${tagName}/SHA256SUMS.txt`;
    const sumsRes = await fetch(sumsUrl, {
      headers: { 'User-Agent': `Svorrent/${this.currentVersion}` },
      signal: AbortSignal.timeout(10000),
    });
    const digests = new Map();
    if (sumsRes.ok) {
      const text = await sumsRes.text();
      for (const line of text.split(/\r?\n/)) {
        const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
        if (m) digests.set(m[2].trim(), `sha256:${m[1].toLowerCase()}`);
      }
    }
    const assetNames = ['Svorrent.dmg', 'Svorrent-Setup.exe', 'Svorrent-Windows-x64-Portable.zip'];
    return {
      tag_name: tagName,
      html_url: `https://github.com/${this.repo}/releases/tag/${tagName}`,
      body: '',
      assets: assetNames.map((name) => ({
        name,
        digest: digests.get(name) || null,
        browser_download_url: `https://github.com/${this.repo}/releases/download/${tagName}/${name}`,
      })),
    };
  }

  async checkForUpdates() {
    const isNewer = this.getStatus().updateAvailable;
    if (this.state.status === 'ready_to_install' && !isNewer) {
      this.state.status = 'idle';
      this.state.assetPath = null;
    }
    if (this.state.status === 'downloading' || (this.state.status === 'ready_to_install' && isNewer)) {
      return this.getStatus();
    }

    this.state.status = 'checking';
    this.state.error = null;
    this.state.lastChecked = new Date().toISOString();

    try {
      const res = await fetch(`https://api.github.com/repos/${this.repo}/releases/latest`, {
        headers: {
          'User-Agent': `Svorrent/${this.currentVersion}`,
          'Accept': 'application/vnd.github+json',
        },
        signal: AbortSignal.timeout(10000),
      });

      let release;
      if (res.status === 403 || res.status === 429) {
        release = await this.fetchLatestReleaseFallback();
      } else if (!res.ok) {
        throw new Error(`GitHub Releases API responded with status ${res.status}`);
      } else {
        release = await res.json();
      }

      const tagName = release.tag_name || release.name || '';
      const newer = isNewerVersion(this.currentVersion, tagName);

      if (!newer) {
        this.state.status = 'idle';
        this.state.latestVersion = tagName;
        return this.getStatus();
      }

      this.state.status = 'available';
      this.state.latestVersion = tagName;
      this.state.releaseNotes = release.body || '';
      this.state.releaseUrl = release.html_url || '';

      const assets = release.assets || [];
      let targetAsset = null;

      if (this.platform === 'darwin') {
        targetAsset = assets.find((a) => a.name.endsWith('.dmg'));
      } else if (this.platform === 'win32') {
        targetAsset = assets.find((a) => a.name.endsWith('Setup.exe')) ||
                      assets.find((a) => a.name.endsWith('.exe'));
      }

      if (targetAsset && targetAsset.browser_download_url) {
        this.downloadUpdate(targetAsset).catch((err) => {
          console.error('[Updater] Background download failed:', err.message);
        });
      }

      return this.getStatus();
    } catch (err) {
      this.state.status = 'error';
      this.state.error = err.message;
      return this.getStatus();
    }
  }

  async downloadUpdate(asset) {
    this.state.status = 'downloading';
    this.state.assetName = asset.name;
    this.state.assetDigest = asset.digest || null;
    this.state.totalBytes = asset.size || 0;
    this.state.downloadedBytes = 0;
    this.state.downloadProgress = 0;

    const targetFile = path.join(this.cacheDir, asset.name);
    const tempFile = `${targetFile}.download`;

    this.abortController = new AbortController();

    try {
      const response = await fetch(asset.browser_download_url, {
        headers: {
          'User-Agent': `Svorrent/${this.currentVersion}`,
        },
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`Download failed with status ${response.status}`);
      }

      const total = Number(response.headers.get('content-length')) || asset.size || 0;
      this.state.totalBytes = total;

      const fileStream = fs.createWriteStream(tempFile);
      const hash = createHash('sha256');
      const reader = response.body.getReader();

      const progressStream = new Readable({
        async read() {
          try {
            const { done, value } = await reader.read();
            if (done) {
              this.push(null);
            } else {
              this.push(Buffer.from(value));
            }
          } catch (e) {
            this.destroy(e);
          }
        },
      });

      progressStream.on('data', (chunk) => {
        hash.update(chunk);
        this.state.downloadedBytes += chunk.length;
        if (this.state.totalBytes > 0) {
          this.state.downloadProgress = Math.min(
            100,
            Math.round((this.state.downloadedBytes / this.state.totalBytes) * 100)
          );
        }
      });

      await pipeline(progressStream, fileStream);
      const computedDigest = `sha256:${hash.digest('hex')}`;
      if (this.state.assetDigest && computedDigest !== this.state.assetDigest) {
        throw new Error('Downloaded update failed SHA-256 verification');
      }
      if (!this.state.assetDigest) {
        this.state.assetDigest = computedDigest;
      }

      if (fs.existsSync(targetFile)) {
        fs.unlinkSync(targetFile);
      }
      fs.renameSync(tempFile, targetFile);

      this.state.assetPath = targetFile;
      this.state.status = 'ready_to_install';
      this.state.downloadProgress = 100;
      console.log(`[Updater] Update downloaded and ready to install: ${targetFile}`);
    } catch (err) {
      if (fs.existsSync(tempFile)) {
        try { fs.unlinkSync(tempFile); } catch {}
      }
      this.state.status = 'error';
      this.state.error = err.message;
      throw err;
    } finally {
      this.abortController = null;
    }
  }

  async applyUpdate() {
    if (this.state.status !== 'ready_to_install' || !this.state.assetPath || !fs.existsSync(this.state.assetPath)) {
      throw new Error('No update is downloaded or ready to install');
    }

    const assetPath = this.state.assetPath;
    console.log(`[Updater] Applying update from ${assetPath}...`);

    if (this.platform === 'win32') {
      if (!/^sha256:[0-9a-f]{64}$/.test(this.state.assetDigest || '')) {
        throw new Error('The downloaded update is missing SHA-256 verification metadata');
      }
      const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      const installer = path.join(backendDir, 'scripts', 'apply-windows-update.ps1');
      fs.accessSync(installer, fs.constants.R_OK);
      const appDir = path.resolve(backendDir, '..');
      const expectedDir = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Svorrent');
      if (path.normalize(appDir).toLowerCase() !== path.normalize(expectedDir).toLowerCase()) {
        throw new Error('Automatic installation requires Svorrent in its standard Windows location');
      }
      const logDir = path.join(process.env.LOCALAPPDATA, 'Svorrent', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logFd = fs.openSync(path.join(logDir, 'update.log'), 'a');
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', installer, '-Installer', assetPath, '-Digest', this.state.assetDigest,
        '-ParentPid', String(process.pid), '-AppDir', appDir], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
      fs.closeSync(logFd);
      if (!child.pid) throw new Error('Could not start the Windows update installer');
      child.unref();

      setTimeout(() => {
        process.exit(0);
      }, 1000);
      return { success: true, message: 'Applying update and restarting Svorrent...' };
    }

    if (this.platform === 'darwin') {
      if (!/^sha256:[0-9a-f]{64}$/.test(this.state.assetDigest || '')) {
        throw new Error('The downloaded update is missing SHA-256 verification metadata');
      }
      const appPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../');
      if (!appPath.startsWith('/Applications/') || path.basename(appPath) !== 'Svorrent.app') {
        throw new Error('Automatic installation requires Svorrent in Applications');
      }
      const installer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/apply-macos-update.sh');
      fs.accessSync(path.dirname(appPath), fs.constants.W_OK);
      fs.accessSync(installer, fs.constants.R_OK);
      const expectedVersion = (this.state.latestVersion || '').replace(/^v/i, '').trim();
      const logDir = path.join(os.homedir(), 'Library', 'Logs', 'Svorrent');
      fs.mkdirSync(logDir, { recursive: true });
      const logFd = fs.openSync(path.join(logDir, 'update.log'), 'a');
      const helper = spawn('/bin/bash', [installer, assetPath, this.state.assetDigest, expectedVersion, appPath], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
      fs.closeSync(logFd);
      if (!helper.pid) throw new Error('Could not start the macOS update installer');
      helper.unref();

      setTimeout(() => {
        process.exit(0);
      }, 1000);
      return { success: true, message: 'Applying update and restarting Svorrent...' };
    }

    return { success: false, message: 'Automatic in-place restart not supported on this platform' };
  }
}
