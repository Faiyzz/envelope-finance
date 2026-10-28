import { expect, type Page } from '@playwright/test';

export const EMAIL = 'e2e@example.com';
export const PASSWORD = 'e2e-password-123';

export async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('total-balance')).toBeVisible();
}

/** Reads the exact paisa value rendered by <AnimatedMoney data-value>. */
export async function totalPaisa(page: Page): Promise<bigint> {
  const v = await page.getByTestId('total-balance').getAttribute('data-value');
  return BigInt(v ?? '0');
}
