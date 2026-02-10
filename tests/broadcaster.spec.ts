import { test, expect } from '@playwright/test';

test.describe('Broadcaster page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/broadcaster.html');
  });

  test('has correct title', async ({ page }) => {
    await expect(page).toHaveTitle('Sebicam - Broadcaster');
  });

  test('shows Start button and hides Stop button initially', async ({ page }) => {
    const btnStart = page.locator('#btn-start');
    const btnStop = page.locator('#btn-stop');

    await expect(btnStart).toBeVisible();
    await expect(btnStop).toBeHidden();
  });

  test('shows status panel with disconnected state', async ({ page }) => {
    const textConnection = page.locator('#text-connection');
    await expect(textConnection).toHaveText('Disconnected');
  });

  test('Start button requests getUserMedia and shows Stop button', async ({ page, context }) => {
    // Grant microphone permission and provide a fake audio stream
    await context.grantPermissions(['microphone']);
    await page.addInitScript(() => {
      const audioCtx = new AudioContext();
      const oscillator = audioCtx.createOscillator();
      const dest = audioCtx.createMediaStreamDestination();
      oscillator.connect(dest);
      oscillator.start();
      navigator.mediaDevices.getUserMedia = async () => dest.stream;
    });
    await page.goto('/broadcaster.html');

    await page.click('#btn-start');

    // After starting, Stop button should become visible
    await expect(page.locator('#btn-stop')).toBeVisible({ timeout: 5000 });
  });
});
