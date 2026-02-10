import { test, expect } from '@playwright/test';

test.describe('Viewer page', () => {
  test.beforeEach(async ({ page, context }) => {
    // Grant camera permission for the QR scanner
    await context.grantPermissions(['camera']);
    await page.goto('/viewer.html');
  });

  test('has correct title', async ({ page }) => {
    await expect(page).toHaveTitle('Sebicam - Viewer');
  });

  test('shows scanner section initially', async ({ page }) => {
    const scannerSection = page.locator('#scanner-section');
    await expect(scannerSection).toBeVisible();
  });

  test('stream section is hidden initially', async ({ page }) => {
    const streamSection = page.locator('#stream-section');
    await expect(streamSection).toBeHidden();
  });

  test('answer QR container is hidden initially', async ({ page }) => {
    const answerQr = page.locator('#answer-qr-container');
    await expect(answerQr).toBeHidden();
  });
});
