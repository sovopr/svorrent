import { test, expect } from '@playwright/test';

test('search, download, pause, play, resume, and remove work in the UI', async ({ page }) => {
  const hash = 'a'.repeat(40);
  const magnet = `magnet:?xt=urn:btih:${hash}&dn=Svorrent%20Test%20Clip`;
  const item = {
    infoHash: hash,
    name: 'Svorrent Test Clip.mp4',
    ready: true,
    paused: false,
    done: false,
    progress: 0.25,
    downloaded: 32768,
    length: 131072,
    downloadSpeed: 1024,
    uploadSpeed: 0,
    numPeers: 1,
    timeRemaining: 30000,
    playability: { isMedia: true, canPlay: true, reason: 'Ready to play', fileName: 'Svorrent Test Clip.mp4' },
  };
  const calls = [];
  let downloaded = false;

  await page.route('**/api/search?*', async (route) => {
    await route.fulfill({
      json: [{ title: item.name, size: '128 KB', seeds: 1, peers: 1, provider: 'Local test', magnet, link: 'https://example.com/test.torrent' }],
    });
  });
  await page.route('**/api/config', async (route) => {
    await route.fulfill({ json: { downloadDir: 'isolated test folder', settings: { autoStopSeeding: false } } });
  });
  await page.route('**/api/torrents', async (route) => {
    await route.fulfill({ json: downloaded ? [item] : [] });
  });
  await page.route('**/api/torrent/download', async (route) => {
    expect(route.request().postDataJSON().magnet).toBe(magnet);
    downloaded = true;
    calls.push('download');
    await route.fulfill({ json: { success: true, infoHash: hash, name: item.name } });
  });
  await page.route('**/api/torrent/*/*', async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').pop();
    calls.push(action);
    if (action === 'pause') item.paused = true;
    if (action === 'resume') item.paused = false;
    if (action === 'delete') {
      expect(route.request().postDataJSON().deleteFiles).toBe(true);
      downloaded = false;
    }
    await route.fulfill({ json: action === 'play' ? { success: true, player: 'Test player', file: item.name } : { success: true } });
  });

  await page.goto('/');
  await page.getByRole('searchbox', { name: 'Search torrents' }).fill('test clip');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('button', { name: `Download ${item.name}` })).toBeVisible();
  await expect(page.locator('.results-table .is-placeholder, .results-table a[download]')).toHaveCount(0);
  await page.getByRole('button', { name: `Download ${item.name}` }).click();
  await expect(page.getByRole('button', { name: `Added ${item.name}` })).toBeVisible();

  await page.locator('#nav-downloads').click();
  const row = page.locator('.dl-row', { hasText: item.name });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Pause' }).click();
  await expect(row.getByRole('button', { name: 'Resume' })).toBeVisible();
  await row.getByRole('button', { name: 'Resume' }).click();
  await expect(row.getByRole('button', { name: 'Pause' })).toBeVisible();
  await row.getByRole('button', { name: 'Play media: Ready to play' }).click();
  await expect(page.getByText(/Opening .* in Test player/)).toBeVisible();

  await row.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog', { name: 'Remove download?' }).getByRole('checkbox').check();
  await page.getByRole('dialog', { name: 'Remove download?' }).getByRole('button', { name: 'Delete files' }).click();
  await expect(page.getByText('No downloads yet.')).toBeVisible();
  expect(calls).toEqual(['download', 'pause', 'resume', 'play', 'delete']);
});
