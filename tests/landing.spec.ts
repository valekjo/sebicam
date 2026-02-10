import { test, expect } from '@playwright/test';

test.describe('Landing page', () => {
  test('has correct title', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('Sebicam');
  });

  test('shows both role cards', async ({ page }) => {
    await page.goto('/');
    const broadcaster = page.locator('a[href="broadcaster.html"]');
    const viewer = page.locator('a[href="viewer.html"]');

    await expect(broadcaster).toBeVisible();
    await expect(viewer).toBeVisible();
    await expect(broadcaster).toContainText('Broadcaster');
    await expect(viewer).toContainText('Viewer');
  });

  test('broadcaster card navigates to broadcaster page', async ({ page }) => {
    await page.goto('/');
    await page.click('a[href="broadcaster.html"]');
    await expect(page).toHaveURL(/broadcaster\.html/);
    await expect(page).toHaveTitle('Sebicam - Broadcaster');
  });

  test('viewer card navigates to viewer page', async ({ page }) => {
    await page.goto('/');
    await page.click('a[href="viewer.html"]');
    await expect(page).toHaveURL(/viewer\.html/);
    await expect(page).toHaveTitle('Sebicam - Viewer');
  });
});
