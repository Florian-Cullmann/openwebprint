import { test, expect } from '@playwright/test';

test('shows a safe status message for an HTML proxy error', async ({ page }, info) => {
  // Intercept only this browser request; no physical device or proxy is required.
  await page.route('**/api/session', (route) =>
    route.fulfill({
      status: 502,
      contentType: 'text/html',
      body: '<html><body>Bad Gateway: private upstream diagnostics</body></html>',
    }),
  );
  await page.goto('/overview');
  await expect(page.getByRole('alert')).toHaveText('The request failed (HTTP 502).');
  await expect(page.getByText('private upstream diagnostics', { exact: false })).toHaveCount(0);
  await page.screenshot({
    path: `test-results/${info.project.name}-api-proxy-error.png`,
    fullPage: true,
  });
});
