import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSemver, isNewerVersion, AutoUpdater } from '../lib/updater.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
