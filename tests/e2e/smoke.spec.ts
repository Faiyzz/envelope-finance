import { expect, test } from '@playwright/test';
import { login, totalPaisa } from './helpers';

test.describe('[URD-45] [URD-49] smoke: auth gate, manifest, offline shell', () => {
  test('signed-out visitors are sent to the login page; registration is a 404', async ({ page, request }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect((await request.get('/register', { maxRedirects: 0 })).status()).toBe(404);
  });

  test('wrong credentials give one generic message (no enumeration)', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('nobody@example.com');
    await page.getByLabel('Password').fill('definitely-wrong-123');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Email or password is incorrect.' })).toBeVisible();
    await page.getByLabel('Email').fill('e2e@example.com');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Email or password is incorrect.' })).toBeVisible();
  });

  test('manifest, icons and security headers', async ({ request }) => {
    const m = await (await request.get('/manifest.webmanifest')).json();
    expect(m).toMatchObject({ display: 'standalone', start_url: '/', short_name: 'Envelopes' });
    for (const icon of m.icons) expect((await request.get(icon.src)).status()).toBe(200);
    const res = await request.get('/login');
    expect(res.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect((await request.get('/api/export/json')).status()).toBe(401);
  });

  test('the offline shell shows no data when nothing was saved', async ({ page }) => {
    await page.goto('/offline');
    await expect(page.getByText('Connect to the internet to load your data.')).toBeVisible();
  });

  test('a signed-in user sees the exact ledger totals from the database', async ({ page }) => {
    await login(page);
    expect(await totalPaisa(page)).toBe(19_750_000n); // 200,000 opening - 2,500 expense
    await expect(page.getByTestId('tile-held')).toContainText('20,000');
    await expect(page.getByTestId('envelope-card-home')).toContainText('50,500'); // 50,000 - 2,500 + 5,000 loan - 2,000 repaid
  });
});
