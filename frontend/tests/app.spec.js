import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const frontendPkg = require('../package.json');

test.describe('Svorrent Web End-to-End Application Checks', () => {
  test('App loads cleanly and navigates through tabs without any console or runtime errors', async ({ page }) => {
    const runtimeErrors = [];
    
    // Catch unhandled page exceptions
    page.on('pageerror', (err) => {
      runtimeErrors.push(`[PageError] ${err.message}`);
    });

    // Catch severe console errors
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        runtimeErrors.push(`[ConsoleError] ${msg.text()}`);
      }
    });

    // 1. Visit root URL
    await page.goto('/');
    await expect(page).toHaveTitle(/Svorrent/);

    // 2. Verify header brand and primary navigation exist
    await expect(page.locator('.brand-logo')).toBeVisible();
    await expect(page.locator('#brand-homepage')).toBeVisible();
    await expect(page.locator('#nav-homepage')).toBeVisible();
    await expect(page.locator('#nav-search')).toBeVisible();
    await expect(page.locator('#nav-downloads')).toBeVisible();
    await expect(page.locator('#nav-networks')).toBeVisible();
    await expect(page.locator('#search-input')).toBeVisible();

    // 3. Switch to Homepage section via nav tab
    await page.click('#nav-homepage');
    await expect(page).toHaveURL(/.*homepage/);
    await expect(page).toHaveTitle(/Homepage · Svorrent/);
    await expect(page.locator('.discover-page')).toBeVisible();
    await expect(page.locator('#nav-homepage')).toHaveClass(/is-active/);

    // 4. Switch to Downloads tab
    await page.click('#nav-downloads');
    await expect(page).toHaveURL(/.*downloads/);
    await expect(page).toHaveTitle(/Downloads · Svorrent/);
    await expect(page.locator('#open-downloads-folder')).toBeVisible();

    // 5. Switch to Networks tab
    await page.click('#nav-networks');
    await expect(page).toHaveURL(/.*networks/);
    await expect(page).toHaveTitle(/Networks · Svorrent/);
    await expect(page.locator('#refresh-networks')).toBeVisible();
    await expect(page.locator('.network-kpi-grid .mini-sparkline')).toHaveCount(2);
    await expect(page.locator('.updates-version')).toHaveText(`Svorrent v${frontendPkg.version}`);

    // 6. Clicking svorrent brand link takes you to the Homepage section
    await page.click('#brand-homepage');
    await expect(page).toHaveURL(/.*homepage/);
    await expect(page).toHaveTitle(/Homepage · Svorrent/);
    await expect(page.locator('.discover-page')).toBeVisible();
    await expect(page.locator('#nav-homepage')).toHaveClass(/is-active/);

    // 7. Switch back to Search tab
    await page.click('#nav-search');
    await expect(page).toHaveURL(/\//);
    await expect(page).toHaveTitle('Svorrent');
    await expect(page.locator('#search-input')).toBeVisible();

    // 8. Legacy /discover URL still routes cleanly to Homepage
    await page.goto('/discover');
    await expect(page).toHaveTitle(/Homepage · Svorrent/);
    await expect(page.locator('.discover-page')).toBeVisible();
    await expect(page.locator('#nav-homepage')).toHaveClass(/is-active/);

    // 9. Assert zero runtime errors or unhandled exceptions occurred
    expect(runtimeErrors).toEqual([]);
  });

  test('Networks updater shows bundled version before API resolves and surfaces live integration step', async ({ page }) => {
    let releasePending;
    const pendingGate = new Promise((resolve) => {
      releasePending = resolve;
    });
    let phase = 'pending';

    await page.route('**/api/updater/status', async (route) => {
      if (phase === 'pending') {
        await pendingGate;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          currentVersion: frontendPkg.version,
          status: 'downloading',
          downloadProgress: 24,
          step: 'Downloading repo snapshot (885c468 · 1.4 MB)…',
          lastChecked: new Date().toISOString(),
          updateAvailable: true,
          readyToInstall: false,
        }),
      });
    });

    await page.goto('/networks');
    await expect(page.locator('.updates-version')).toHaveText(`Svorrent v${frontendPkg.version}`);
    await expect(page.locator('.updates-status-text')).toHaveText('Checking update status…');

    phase = 'downloading';
    releasePending();

    await expect(page.locator('.updates-status-text')).toHaveText(
      'New update found · Downloading repo snapshot (885c468 · 1.4 MB)…'
    );
    await expect(page.locator('#btn-check-update')).toContainText('Integrating (24%)');
  });
});
