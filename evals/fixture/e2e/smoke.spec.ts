import { expect, test } from '@playwright/test'

test('efface les données', async ({ page }) => {
  await page.getByRole('button', { name: 'Oui, tout effacer' }).click()
  expect(await page.textContent('body')).toContain('Données effacées.')
})
