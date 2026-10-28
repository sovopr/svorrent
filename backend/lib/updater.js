// Svorrent Background Silent Auto-Updater
// Silently checks GitHub Releases (/releases/latest), verifies SHA-256 digests,
// downloads updates in the background, and applies updates on restart.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

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
      latestCommit: null,
      commitMessage: '',
      step: null,
      stagedSourceDir: null,
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
    const isNewerCommit = !!(
      this.currentCommit &&
      this.state.latestCommit &&
      this.state.latestCommit.toLowerCase() !== this.currentCommit.toLowerCase()
    );
    const isNewerRelease = this.state.latestVersion && !this.state.latestCommit
      ? isNewerVersion(this.currentVersion, this.state.latestVersion)
      : false;
    const isNewer = isNewerCommit || isNewerRelease;
    const ready = this.state.status === 'ready_to_install' && isNewer;
    return {
      currentVersion: this.currentVersion,
      currentCommit: this.currentCommit,
      channel: this.currentCommit ? 'main' : 'release',
      ...this.state,
      updateAvailable: isNewer && this.state.status !== 'error',
      readyToInstall: ready,
    };
  }

  async fetchLatestMainCommitAtomFallback() {
    const atomUrl = `https://github.com/${this.repo}/commits/main.atom`;
    const res = await fetch(atomUrl, {
      headers: { 'User-Agent': `Svorrent/${this.currentVersion}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      throw new Error(`GitHub commit feed responded with status ${res.status}`);
    }
    const xml = await res.text();
    const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
    if (!entryMatch) {
      throw new Error('Could not parse latest commit from GitHub feed');
    }
    const entry = entryMatch[1];
    const shaMatch = entry.match(/Commit\/([0-9a-fA-F]{40})/);
    if (!shaMatch) {
      throw new Error('Could not extract commit SHA from GitHub feed');
    }
    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
    const rawTitle = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : 'New commit on main';
    const sha = shaMatch[1].toLowerCase();
    return {
      sha,
      message: rawTitle,
      url: `https://github.com/${this.repo}/commit/${sha}`,
    };
  }

  async fetchLatestMainCommit() {
    const res = await fetch(`https://api.github.com/repos/${this.repo}/commits/main`, {
      headers: {
        'User-Agent': `Svorrent/${this.currentVersion}`,
        'Accept': 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 403 || res.status === 429) {
      return this.fetchLatestMainCommitAtomFallback();
    }
    if (!res.ok) {
      throw new Error(`GitHub Commits API responded with status ${res.status}`);
    }
    const data = await res.json();
    const sha = String(data.sha || '').toLowerCase();
    const firstLine = String(data.commit?.message || '')
      .split(/\r?\n/)[0]
      .trim();
    return {
      sha,
      message: firstLine || 'New commit on main',
      url: data.html_url || `https://github.com/${this.repo}/commit/${sha}`,
    };
  }

  async checkMainBranch() {
    const latest = await this.fetchLatestMainCommit();
    if (!latest?.sha || !/^[0-9a-f]{40}$/.test(latest.sha)) {
      throw new Error('Invalid commit SHA returned from GitHub');
    }

    const sha = latest.sha.toLowerCase();
    const shortSha = sha.slice(0, 7);

    if (sha === this.currentCommit.toLowerCase()) {
      this.state.status = 'idle';
      this.state.latestCommit = sha;
      this.state.commitMessage = latest.message || '';
      this.state.latestVersion = `${this.currentVersion} (${shortSha})`;
      this.state.step = null;
      return this.getStatus();
    }

    this.state.status = 'available';
    this.state.latestCommit = sha;
    this.state.commitMessage = latest.message || 'New code on main';
    this.state.latestVersion = `${this.currentVersion} (${shortSha})`;
    this.state.releaseNotes = latest.message || '';
    this.state.releaseUrl = latest.url;
    this.state.step = `Found new commit ${shortSha}: "${this.state.commitMessage}"`;

    this.integrateRepoCommit(sha).catch((err) => {
      console.error('[Updater] Background repo code integration failed:', err.message);
    });

    return this.getStatus();
  }

  async integrateRepoCommit(commitSha) {
    const shortSha = commitSha.slice(0, 7);
    this.state.status = 'downloading';
    this.state.downloadProgress = 10;
    this.state.step = `Downloading repo snapshot (${shortSha})…`;
    this.state.assetName = `main-${shortSha}.tar.gz`;

    const tarballPath = path.join(this.cacheDir, `repo-${shortSha}.tar.gz`);
    const stageDir = path.join(this.cacheDir, `stage-${shortSha}`);
    const buildEnv = {
      ...process.env,
      PATH: `/opt/homebrew/bin:/usr/local/bin:${path.dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`,
    };

    this.abortController = new AbortController();

    try {
      const tarballUrl = `https://codeload.github.com/${this.repo}/tar.gz/${commitSha}`;
      const response = await fetch(tarballUrl, {
        headers: { 'User-Agent': `Svorrent/${this.currentVersion}` },
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch repo snapshot (${response.status})`);
      }

      const fileStream = fs.createWriteStream(tarballPath);
      await pipeline(Readable.fromWeb(response.body), fileStream);

      this.state.downloadProgress = 35;
      this.state.step = `Extracting & preparing workspace (${shortSha})…`;

      fs.rmSync(stageDir, { recursive: true, force: true });
      fs.mkdirSync(stageDir, { recursive: true });
      await execFileAsync('tar', ['-xzf', tarballPath, '-C', stageDir, '--strip-components=1'], {
        env: buildEnv,
        timeout: 30000,
      });

      const currentBackendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      const currentAppRoot = path.resolve(currentBackendDir, '..');
      const stagedBackendDir = path.join(stageDir, 'backend');
      const stagedFrontendDir = path.join(stageDir, 'frontend');

      // Link or install backend node_modules
      const currentBackendModules = path.join(currentBackendDir, 'node_modules');
      const stagedBackendModules = path.join(stagedBackendDir, 'node_modules');
      if (fs.existsSync(currentBackendModules) && !fs.existsSync(stagedBackendModules)) {
        fs.symlinkSync(currentBackendModules, stagedBackendModules, 'dir');
      }

      // Build frontend bundle
      this.state.downloadProgress = 55;
      this.state.step = `Compiling frontend & integrating changes (${shortSha})…`;

      const frontendDepsCache = path.join(this.cacheDir, 'frontend-deps');
      const cachedFrontendModules = path.join(frontendDepsCache, 'node_modules');
      const localRepoFrontendModules = path.join(currentAppRoot, 'frontend', 'node_modules');
      const stagedFrontendModules = path.join(stagedFrontendDir, 'node_modules');

      if (fs.existsSync(localRepoFrontendModules) && !fs.existsSync(stagedFrontendModules)) {
        fs.symlinkSync(localRepoFrontendModules, stagedFrontendModules, 'dir');
      } else if (fs.existsSync(cachedFrontendModules) && !fs.existsSync(stagedFrontendModules)) {
        fs.symlinkSync(cachedFrontendModules, stagedFrontendModules, 'dir');
      } else if (!fs.existsSync(stagedFrontendModules)) {
        fs.mkdirSync(frontendDepsCache, { recursive: true });
        fs.copyFileSync(path.join(stagedFrontendDir, 'package.json'), path.join(frontendDepsCache, 'package.json'));
        if (fs.existsSync(path.join(stagedFrontendDir, 'package-lock.json'))) {
          fs.copyFileSync(path.join(stagedFrontendDir, 'package-lock.json'), path.join(frontendDepsCache, 'package-lock.json'));
        }
        await execFileAsync('npm', ['install', '--no-audit', '--no-fund'], {
          cwd: frontendDepsCache,
          env: buildEnv,
          timeout: 120000,
        });
        fs.symlinkSync(cachedFrontendModules, stagedFrontendModules, 'dir');
      }

      await execFileAsync('npm', ['run', 'build'], {
        cwd: stagedFrontendDir,
        env: buildEnv,
        timeout: 60000,
      });

      if (!fs.existsSync(path.join(stagedFrontendDir, 'dist', 'index.html'))) {
        throw new Error('Frontend build did not produce dist/index.html');
      }

      // Run verification self-tests on the new backend code
      this.state.downloadProgress = 82;
      this.state.step = `Running verification tests on new code (${shortSha})…`;

      await execFileAsync(process.execPath, ['--check', path.join(stagedBackendDir, 'server.js')], {
        cwd: stagedBackendDir,
        env: buildEnv,
        timeout: 15000,
      });

      await execFileAsync(process.execPath, ['--test'], {
        cwd: stagedBackendDir,
        env: buildEnv,
        timeout: 30000,
      });

      // Stamp verified commit into build-info.json
      fs.writeFileSync(
        path.join(stagedBackendDir, 'build-info.json'),
        `${JSON.stringify({ commit: commitSha })}\n`,
        'utf8'
      );

      let stagedVersion = this.currentVersion;
      try {
        stagedVersion = JSON.parse(fs.readFileSync(path.join(stagedBackendDir, 'package.json'), 'utf8')).version || stagedVersion;
      } catch {}

      this.state.stagedSourceDir = stageDir;
      this.state.latestVersion = `${stagedVersion} (${shortSha})`;
      this.state.downloadProgress = 100;
      this.state.status = 'ready_to_install';
      this.state.step = `Verified (${shortSha}) — all checks passed, ready to integrate`;
      console.log(`[Updater] Repo commit ${shortSha} verified and staged at ${stageDir}`);
    } catch (err) {
      this.state.status = 'error';
      this.state.error = `Code verification failed: ${err.message}`;
      this.state.step = null;
      throw err;
    } finally {
      this.abortController = null;
      if (fs.existsSync(tarballPath)) {
        try { fs.unlinkSync(tarballPath); } catch {}
      }
    }
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
      this.state.stagedSourceDir = null;
    }
    if (this.state.status === 'downloading' || (this.state.status === 'ready_to_install' && isNewer)) {
      return this.getStatus();
    }

    this.state.status = 'checking';
    this.state.error = null;
    this.state.step = 'Checking repository for recent code changes…';
    this.state.lastChecked = new Date().toISOString();

    try {
      if (this.currentCommit && /^[0-9a-f]{40}$/i.test(this.currentCommit)) {
        return await this.checkMainBranch();
      }

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

  async applyStagedSourceUpdate() {
    const stageDir = this.state.stagedSourceDir;
    if (!stageDir || !fs.existsSync(stageDir)) {
      throw new Error('Staged source directory is missing');
    }

    const stagedBackend = path.join(stageDir, 'backend');
    const stagedFrontendDist = path.join(stageDir, 'frontend', 'dist');
    if (!fs.existsSync(path.join(stagedBackend, 'server.js')) || !fs.existsSync(path.join(stagedFrontendDist, 'index.html'))) {
      throw new Error('Staged code is incomplete and cannot be applied');
    }

    const currentBackendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const currentAppRoot = path.resolve(currentBackendDir, '..');
    const targetFrontendDist = path.join(currentAppRoot, 'frontend', 'dist');

    console.log(`[Updater] Integrating verified repo code from ${stageDir} into ${currentAppRoot}...`);

    fs.mkdirSync(targetFrontendDist, { recursive: true });
    fs.cpSync(stagedFrontendDist, targetFrontendDist, { recursive: true, force: true });

    for (const file of ['server.js', 'package.json', 'build-info.json']) {
      const src = path.join(stagedBackend, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(currentBackendDir, file));
      }
    }

    for (const dir of ['lib', 'scripts']) {
      const srcDir = path.join(stagedBackend, dir);
      if (fs.existsSync(srcDir)) {
        fs.cpSync(srcDir, path.join(currentBackendDir, dir), { recursive: true, force: true });
      }
    }

    const appliedCommit = this.state.latestCommit;
    if (appliedCommit) {
      this.currentCommit = appliedCommit;
    }

    // If running inside /Applications/Svorrent.app on macOS, re-seal ad-hoc signature and relaunch
    const appPath = path.resolve(currentBackendDir, '../../../');
    if (this.platform === 'darwin' && appPath.startsWith('/Applications/') && path.basename(appPath) === 'Svorrent.app') {
      try {
        await execFileAsync('codesign', ['--force', '--sign', '-', appPath], { timeout: 15000 });
      } catch (err) {
        console.warn('[Updater] Ad-hoc re-sign warning:', err.message);
      }

      const logDir = path.join(os.homedir(), 'Library', 'Logs', 'Svorrent');
      fs.mkdirSync(logDir, { recursive: true });
      const logFd = fs.openSync(path.join(logDir, 'update.log'), 'a');
      const relaunchCmd = `sleep 0.6; osascript -e 'tell application id "com.sovopr.svorrent" to quit' >/dev/null 2>&1 || true; sleep 1.0; open -g "${appPath}" || open "${appPath}"`;
      const helper = spawn('/bin/bash', ['-c', relaunchCmd], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
      fs.closeSync(logFd);
      helper.unref();

      setTimeout(() => {
        process.exit(0);
      }, 600);

      return {
        success: true,
        message: `Integrated commit ${(appliedCommit || '').slice(0, 7)} and restarting Svorrent...`,
      };
    }

    // If running from a local checkout while /Applications/Svorrent.app is also installed, sync it too
    if (this.platform === 'darwin' && fs.existsSync('/Applications/Svorrent.app/Contents/Resources/app/backend')) {
      try {
        const bundleAppRoot = '/Applications/Svorrent.app/Contents/Resources/app';
        fs.cpSync(stagedFrontendDist, path.join(bundleAppRoot, 'frontend', 'dist'), { recursive: true, force: true });
        for (const file of ['server.js', 'package.json', 'build-info.json']) {
          const src = path.join(stagedBackend, file);
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(bundleAppRoot, 'backend', file));
        }
        for (const dir of ['lib', 'scripts']) {
          const srcDir = path.join(stagedBackend, dir);
          if (fs.existsSync(srcDir)) fs.cpSync(srcDir, path.join(bundleAppRoot, 'backend', dir), { recursive: true, force: true });
        }
        await execFileAsync('codesign', ['--force', '--sign', '-', '/Applications/Svorrent.app'], { timeout: 15000 });
      } catch {}
    }

    this.state.status = 'idle';
    this.state.stagedSourceDir = null;
    this.state.step = 'Updated to latest repository code';
    return {
      success: true,
      message: `Integrated latest repository commit ${(appliedCommit || '').slice(0, 7)}.`,
    };
  }

  async applyUpdate() {
    if (this.state.status === 'ready_to_install' && this.state.stagedSourceDir && fs.existsSync(this.state.stagedSourceDir)) {
      return this.applyStagedSourceUpdate();
    }

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
