import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { parseSemver, isNewerVersion, AutoUpdater, resolveTarBinary } from '../lib/updater.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

test('parseSemver parses clean and prefixed versions correctly', () => {
  assert.deepEqual(parseSemver('1.0.1'), [1, 0, 1]);
  assert.deepEqual(parseSemver('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseSemver('V2.0'), [2, 0, 0]);
  assert.deepEqual(parseSemver(''), [0, 0, 0]);
  assert.deepEqual(parseSemver(null), [0, 0, 0]);
});

test('isNewerVersion detects major, minor, and patch upgrades correctly', () => {
  assert.equal(isNewerVersion('1.0.1', '1.0.2'), true);
  assert.equal(isNewerVersion('1.0.1', 'v1.1.0'), true);
  assert.equal(isNewerVersion('1.0.1', '2.0.0'), true);
  assert.equal(isNewerVersion('1.0.1', '1.0.1'), false);
  assert.equal(isNewerVersion('1.0.2', '1.0.1'), false);
  assert.equal(isNewerVersion('2.0.0', '1.9.9'), false);
});

test('AutoUpdater initializes in idle state with correct version metadata', () => {
  const updater = new AutoUpdater({ currentVersion: '1.0.4' });
  const status = updater.getStatus();
  assert.equal(status.currentVersion, '1.0.4');
  assert.equal(status.channel, 'release');
  assert.equal(status.status, 'idle');
  assert.equal(status.readyToInstall, false);
});

test('macOS updater selects the DMG asset from latest GitHub release', async () => {
  const asset = {
    name: 'Svorrent.dmg',
    digest: `sha256:${'c'.repeat(64)}`,
    browser_download_url: 'https://github.com/sovopr/svorrent/releases/download/v1.0.5/Svorrent.dmg',
  };
  const updater = new AutoUpdater({ platform: 'darwin', currentVersion: '1.0.4' });
  const originalFetch = globalThis.fetch;
  let selected = null;
  updater.downloadUpdate = async (item) => { selected = item; };
  globalThis.fetch = async (url) => {
    assert.ok(url.endsWith('/releases/latest'));
    return Response.json({
      tag_name: 'v1.0.5',
      html_url: 'https://github.com/sovopr/svorrent/releases/tag/v1.0.5',
      assets: [{ name: 'Svorrent-Setup.exe', browser_download_url: 'https://example.invalid/win.exe' }, asset],
    });
  };
  try {
    const status = await updater.checkForUpdates();
    assert.equal(status.channel, 'release');
    assert.equal(status.latestVersion, 'v1.0.5');
    assert.equal(status.updateAvailable, true);
    assert.deepEqual(selected, asset);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Windows updater selects the Setup.exe asset from latest GitHub release', async () => {
  const asset = {
    name: 'Svorrent-Setup.exe',
    digest: `sha256:${'c'.repeat(64)}`,
    browser_download_url: 'https://github.com/sovopr/svorrent/releases/download/v1.0.5/Svorrent-Setup.exe',
  };
  const updater = new AutoUpdater({ platform: 'win32', currentVersion: '1.0.4' });
  const originalFetch = globalThis.fetch;
  let selected = null;
  updater.downloadUpdate = async (item) => { selected = item; };
  globalThis.fetch = async (url) => {
    assert.ok(url.endsWith('/releases/latest'));
    return Response.json({
      tag_name: 'v1.0.5',
      html_url: 'https://github.com/sovopr/svorrent/releases/tag/v1.0.5',
      assets: [{ name: 'Svorrent.dmg', browser_download_url: 'https://example.invalid/mac.dmg' }, asset],
    });
  };
  try {
    const status = await updater.checkForUpdates();
    assert.equal(status.channel, 'release');
    assert.equal(status.latestVersion, 'v1.0.5');
    assert.equal(status.updateAvailable, true);
    assert.deepEqual(selected, asset);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Updater stays idle when already on the latest release and reports HTTP errors', async () => {
  const updater = new AutoUpdater({ platform: 'darwin', currentVersion: '1.0.4' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ tag_name: 'v1.0.4', assets: [] });
  try {
    const upToDate = await updater.checkForUpdates();
    assert.equal(upToDate.status, 'idle');
    assert.equal(upToDate.updateAvailable, false);

    globalThis.fetch = async (url) => {
      if (url.startsWith('https://api.github.com/')) {
        return Response.json({}, { status: 403 });
      }
      if (url.endsWith('/releases/latest')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://github.com/sovopr/svorrent/releases/tag/v1.0.5' },
        });
      }
      return new Response(`${'d'.repeat(64)}  Svorrent.dmg\n`, { status: 200 });
    };
    let fallbackAsset = null;
    updater.downloadUpdate = async (item) => { fallbackAsset = item; };
    const fallbackStatus = await updater.checkForUpdates();
    assert.equal(fallbackStatus.status, 'available');
    assert.equal(fallbackStatus.latestVersion, 'v1.0.5');
    assert.equal(fallbackAsset.digest, `sha256:${'d'.repeat(64)}`);

    updater.state.status = 'idle';
    updater.state.latestVersion = null;
    globalThis.fetch = async () => Response.json({}, { status: 503 });
    const failed = await updater.checkForUpdates();
    assert.equal(failed.status, 'error');
    assert.equal(failed.updateAvailable, false);
    assert.match(failed.error, /503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Updater rejects a downloaded build with the wrong SHA-256 digest', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svorrent-updater-test-'));
  const updater = new AutoUpdater({ platform: 'darwin', cacheDir });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('not a valid DMG');
  try {
    await assert.rejects(updater.downloadUpdate({
      name: 'Svorrent-test.dmg',
      digest: `sha256:${'0'.repeat(64)}`,
      browser_download_url: 'https://example.invalid/build.dmg',
    }), /SHA-256 verification/);
    assert.equal(fs.existsSync(path.join(cacheDir, 'Svorrent-test.dmg')), false);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('Updater checks main branch commits when currentCommit is present and triggers repo integration', async () => {
  const oldSha = '1111111111111111111111111111111111111111';
  const newSha = '2222222222222222222222222222222222222222';
  const docsSha = '3333333333333333333333333333333333333333';
  const updater = new AutoUpdater({
    platform: 'darwin',
    currentVersion: '1.0.4',
    currentCommit: oldSha,
  });

  let integratedSha = null;
  updater.integrateRepoCommit = async (sha) => {
    integratedSha = sha;
  };
  updater.persistCurrentCommit = (sha) => {
    updater.currentCommit = sha;
  };

  let latestCommitResponse = {
    sha: newSha,
    html_url: `https://github.com/sovopr/svorrent/commit/${newSha}`,
    commit: { message: 'perf(engine): boost per-wire block pipeline\n\nDetails here' },
    files: [{ filename: 'backend/lib/torrents.js' }],
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/compare/')) {
      return Response.json({ files: latestCommitResponse.files });
    }
    assert.ok(url.endsWith('/commits/main'));
    return Response.json(latestCommitResponse);
  };

  try {
    const status = await updater.checkForUpdates();
    assert.equal(status.channel, 'main');
    assert.equal(status.updateAvailable, true);
    assert.equal(status.latestCommit, newSha);
    assert.equal(status.commitMessage, 'perf(engine): boost per-wire block pipeline');
    assert.equal(integratedSha, newSha);

    // Docs-only commit (README.md / docs/**) should fast-forward currentCommit without prompting or integrating
    updater.currentCommit = newSha;
    updater.state.status = 'idle';
    integratedSha = null;
    latestCommitResponse = {
      sha: docsSha,
      html_url: `https://github.com/sovopr/svorrent/commit/${docsSha}`,
      commit: { message: 'docs(readme): refresh screenshots' },
      files: [{ filename: 'README.md' }, { filename: 'docs/screenshots/search.webp' }],
    };

    const docsOnlyStatus = await updater.checkForUpdates();
    assert.equal(docsOnlyStatus.updateAvailable, false);
    assert.equal(docsOnlyStatus.status, 'idle');
    assert.equal(updater.currentCommit, docsSha);
    assert.equal(integratedSha, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('downloadUpdate recreates a missing cacheDir and computes SHA-256 cleanly', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svorrent-updater-dl-'));
  const cacheDir = path.join(baseDir, 'missing', 'updates');
  const payload = Buffer.from('valid installer payload');
  const expectedDigest = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
  const updater = new AutoUpdater({ platform: 'darwin', cacheDir, currentVersion: '1.0.11' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(payload);
  try {
    await updater.downloadUpdate({
      name: 'Svorrent-test.dmg',
      digest: expectedDigest,
      browser_download_url: 'https://example.invalid/build.dmg',
    });
    assert.equal(fs.existsSync(path.join(cacheDir, 'Svorrent-test.dmg')), true);
    assert.equal(updater.getStatus().status, 'ready_to_install');
    assert.equal(updater.getStatus().downloadProgress, 100);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('integrateRepoCommit recreates missing cacheDir, deduplicates concurrent runs, and resets progress on error', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svorrent-updater-repo-'));
  const missingFailCacheDir = path.join(baseDir, 'missing-fail', 'updates');
  const failUpdater = new AutoUpdater({ platform: 'darwin', cacheDir: missingFailCacheDir, currentVersion: '1.0.11' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('server error', { status: 500 });

  try {
    await assert.rejects(
      failUpdater.integrateRepoCommit('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      /500/
    );
    assert.equal(fs.existsSync(missingFailCacheDir), true);
    assert.equal(failUpdater.getStatus().status, 'error');
    assert.equal(failUpdater.getStatus().downloadProgress, 0);

    // Build a synthetic source snapshot tarball to verify full integration when cacheDir is absent
    const srcRoot = path.join(baseDir, 'snapshot-src');
    fs.mkdirSync(path.join(srcRoot, 'snap', 'backend', 'test'), { recursive: true });
    fs.mkdirSync(path.join(srcRoot, 'snap', 'frontend'), { recursive: true });
    fs.writeFileSync(
      path.join(srcRoot, 'snap', 'backend', 'package.json'),
      JSON.stringify({ name: 'backend', version: '1.0.12', type: 'module' })
    );
    fs.writeFileSync(path.join(srcRoot, 'snap', 'backend', 'server.js'), 'export const ok = true;\n');
    fs.writeFileSync(
      path.join(srcRoot, 'snap', 'backend', 'test', 'smoke.test.js'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('smoke', () => assert.ok(true));\n"
    );
    fs.writeFileSync(
      path.join(srcRoot, 'snap', 'frontend', 'package.json'),
      JSON.stringify({
        name: 'frontend',
        private: true,
        scripts: {
          build: "node -e \"const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','<html></html>')\"",
        },
      })
    );

    const tarballFile = path.join(baseDir, 'snapshot.tar.gz');
    execFileSync(resolveTarBinary(), ['-czf', 'snapshot.tar.gz', '-C', 'snapshot-src', 'snap'], {
      cwd: baseDir,
    });
    const tarballBytes = fs.readFileSync(tarballFile);

    const missingSuccessCacheDir = path.join(baseDir, 'missing-ok', 'updates');
    const okUpdater = new AutoUpdater({
      platform: 'linux',
      cacheDir: missingSuccessCacheDir,
      currentVersion: '1.0.11',
      currentCommit: '0000000000000000000000000000000000000000',
    });

    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response(tarballBytes, {
        status: 200,
        headers: { 'content-length': String(tarballBytes.length) },
      });
    };

    const sha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    await Promise.all([
      okUpdater.integrateRepoCommit(sha),
      okUpdater.integrateRepoCommit(sha),
    ]);

    const status = okUpdater.getStatus();
    assert.equal(fetchCount, 1);
    assert.equal(status.status, 'ready_to_install');
    assert.equal(status.downloadProgress, 100);
    assert.equal(status.latestVersion, '1.0.12 (bbbbbbb)');
    assert.equal(fs.existsSync(path.join(status.stagedSourceDir, 'frontend', 'dist', 'index.html')), true);
    const buildInfo = JSON.parse(
      fs.readFileSync(path.join(status.stagedSourceDir, 'backend', 'build-info.json'), 'utf8')
    );
    assert.equal(buildInfo.commit, sha);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('persistCurrentCommit updates backend build-info.json', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svorrent-updater-commit-'));
  const backendDir = path.join(baseDir, 'backend');
  fs.mkdirSync(backendDir, { recursive: true });
  fs.writeFileSync(
    path.join(backendDir, 'build-info.json'),
    JSON.stringify({ commit: '1111111111111111111111111111111111111111' })
  );

  const updater = new AutoUpdater({ currentVersion: '1.0.11' });
  const nextSha = '9999999999999999999999999999999999999999';
  try {
    updater.persistCurrentCommit(nextSha, backendDir);
    assert.equal(updater.currentCommit, nextSha);
    const written = JSON.parse(fs.readFileSync(path.join(backendDir, 'build-info.json'), 'utf8'));
    assert.equal(written.commit, nextSha);
    assert.ok(written.updatedAt);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('ensureStagedFrontendDeps replaces broken symlinks and heals incomplete node_modules caches', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svorrent-updater-deps-'));
  const cacheDir = path.join(baseDir, 'cache');
  const appRoot = path.join(baseDir, 'app');
  const stagedFrontend = path.join(baseDir, 'stage-abc1234', 'frontend');
  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.mkdirSync(stagedFrontend, { recursive: true });
  fs.mkdirSync(appRoot, { recursive: true });

  const frontendPkg = JSON.stringify({
    name: 'frontend',
    private: true,
    dependencies: { react: '^19.0.0' },
    devDependencies: { vite: '^8.0.0' },
  });
  fs.writeFileSync(path.join(stagedFrontend, 'package.json'), frontendPkg);

  // Simulate a dangling symlink at stage/frontend/node_modules AND a corrupted cache missing vite
  const depsCache = path.join(cacheDir, 'frontend-deps');
  fs.mkdirSync(path.join(depsCache, 'node_modules', 'react'), { recursive: true });
  fs.writeFileSync(path.join(depsCache, 'package.json'), frontendPkg);
  fs.symlinkSync(path.join(baseDir, 'nonexistent-target'), path.join(stagedFrontend, 'node_modules'), symlinkType);

  // Cross-platform fake npm script that populates react + vite and verifies NODE_ENV=development
  const binDir = path.join(baseDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const fakeScript = path.join(binDir, 'fake-npm.js');
  const markerFile = path.join(baseDir, 'install-ran.json');
  fs.writeFileSync(
    fakeScript,
    `const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === 'fail') process.exit(1);
fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify({ nodeEnv: process.env.NODE_ENV, args: process.argv.slice(2) }));
fs.mkdirSync(path.join(process.cwd(), 'node_modules', 'react'), { recursive: true });
fs.mkdirSync(path.join(process.cwd(), 'node_modules', 'vite', 'bin'), { recursive: true });
fs.mkdirSync(path.join(process.cwd(), 'node_modules', '.bin'), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js'), '// vite');
fs.writeFileSync(path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite'), '// bin', { mode: 0o755 });
`
  );
  let npmBin;
  if (process.platform === 'win32') {
    npmBin = path.join(binDir, 'npm.cmd');
    fs.writeFileSync(npmBin, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`);
  } else {
    npmBin = path.join(binDir, 'npm');
    fs.writeFileSync(npmBin, `#!/bin/sh\n"${process.execPath}" "${fakeScript}" "$@"\n`, { mode: 0o755 });
  }

  const updater = new AutoUpdater({ platform: process.platform, cacheDir, currentVersion: '1.0.12' });
  try {
    await updater.ensureStagedFrontendDeps(
      stagedFrontend,
      appRoot,
      symlinkType,
      npmBin,
      { ...process.env, NODE_ENV: 'production' }
    );

    const ran = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    assert.equal(ran.nodeEnv, 'development');
    assert.ok(ran.args.includes('--include=dev'));
    assert.equal(fs.existsSync(path.join(depsCache, '.svorrent-install-ok.json')), true);
    assert.equal(fs.existsSync(path.join(stagedFrontend, 'node_modules', 'vite', 'bin', 'vite.js')), true);

    // Second run with dangling symlink at another stage directory reuses stamped cache without invoking npm
    fs.unlinkSync(markerFile);
    const secondStage = path.join(baseDir, 'stage-def5678', 'frontend');
    fs.mkdirSync(secondStage, { recursive: true });
    fs.writeFileSync(path.join(secondStage, 'package.json'), frontendPkg);
    fs.symlinkSync(path.join(baseDir, 'nonexistent-target-2'), path.join(secondStage, 'node_modules'), symlinkType);

    await updater.ensureStagedFrontendDeps(secondStage, appRoot, symlinkType, npmBin, process.env);
    assert.equal(fs.existsSync(markerFile), false);
    assert.equal(fs.existsSync(path.join(secondStage, 'node_modules', 'vite', 'bin', 'vite.js')), true);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('integrateRepoCommit superseding waits for aborted run without clobbering newer state and prunes old stages', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svorrent-updater-supersede-'));
  const srcRoot = path.join(baseDir, 'snap-src');
  fs.mkdirSync(path.join(srcRoot, 'snap', 'backend', 'test'), { recursive: true });
  fs.mkdirSync(path.join(srcRoot, 'snap', 'frontend'), { recursive: true });
  fs.writeFileSync(
    path.join(srcRoot, 'snap', 'backend', 'package.json'),
    JSON.stringify({ name: 'backend', version: '1.0.12', type: 'module' })
  );
  fs.writeFileSync(path.join(srcRoot, 'snap', 'backend', 'server.js'), 'export const ok = true;\n');
  fs.writeFileSync(
    path.join(srcRoot, 'snap', 'backend', 'test', 'smoke.test.js'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('smoke', () => assert.ok(true));\n"
  );
  fs.writeFileSync(
    path.join(srcRoot, 'snap', 'frontend', 'package.json'),
    JSON.stringify({
      name: 'frontend',
      private: true,
      scripts: {
        build: "node -e \"const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','<html></html>')\"",
      },
    })
  );

  const tarballFile = path.join(baseDir, 'snapshot.tar.gz');
  execFileSync(resolveTarBinary(), ['-czf', 'snapshot.tar.gz', '-C', 'snap-src', 'snap'], { cwd: baseDir });
  const tarballBytes = fs.readFileSync(tarballFile);

  const cacheDir = path.join(baseDir, 'updates');
  fs.mkdirSync(path.join(cacheDir, 'stage-0000000'), { recursive: true });

  const sha1 = 'cccccccccccccccccccccccccccccccccccccccc';
  const sha2 = 'dddddddddddddddddddddddddddddddddddddddd';
  const updater = new AutoUpdater({
    platform: 'linux',
    cacheDir,
    currentVersion: '1.0.12',
    currentCommit: '1111111111111111111111111111111111111111',
  });

  const originalFetch = globalThis.fetch;
  let releaseFirstFetch;
  const firstFetchStarted = new Promise((resolve) => {
    releaseFirstFetch = resolve;
  });

  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith(sha1)) {
      releaseFirstFetch();
      return await new Promise((resolve, reject) => {
        if (init.signal?.aborted) {
          reject(init.signal.reason || new Error('Aborted'));
          return;
        }
        init.signal?.addEventListener('abort', () => {
          reject(init.signal.reason || new Error('Aborted'));
        }, { once: true });
      });
    }
    return new Response(tarballBytes, {
      status: 200,
      headers: { 'content-length': String(tarballBytes.length) },
    });
  };

  try {
    const firstPromise = updater.integrateRepoCommit(sha1).catch(() => {});
    await firstFetchStarted;
    const secondPromise = updater.integrateRepoCommit(sha2);
    await Promise.all([firstPromise, secondPromise]);

    const status = updater.getStatus();
    assert.equal(status.status, 'ready_to_install');
    assert.equal(status.downloadProgress, 100);
    assert.equal(fs.existsSync(path.join(cacheDir, 'stage-0000000')), false);
    assert.equal(fs.existsSync(path.join(cacheDir, `stage-${sha2.slice(0, 7)}`, 'frontend', 'dist', 'index.html')), true);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
