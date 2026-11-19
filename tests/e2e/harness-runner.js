import assert from 'node:assert/strict';

export async function runBrowserHarness(page, baseUrl, onReport = () => {}) {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const origin = new URL(normalizedBase).origin;
  const pageErrors = [];
  const externalRequests = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) externalRequests.push(request.url());
  });
  await page.goto(new URL('tests/browser-harness.html', normalizedBase).href);
  await page.locator('#run').click();
  await page.locator('#status').filter({ hasText: /\d+\/\d+ checks passed\./ }).waitFor({ timeout: 100000 });
  const main = JSON.parse(await page.locator('#summary').textContent());
  await onReport('audio-browser-checks', main);
  assert.ok(main.results.length >= 12, 'The complete browser verification suite did not run.');
  const failures = main.results.filter((result) => result.status !== 'pass');
  assert.deepEqual(failures, [], `Browser audio checks failed: ${JSON.stringify(failures)}`);
  // Reload the page to discard module state before checking persistent PCM.
  await page.reload();
  await page.locator('#reload-check').click();
  await page.locator('#status').filter({ hasText: 'Persistence check finished.' }).waitFor({ timeout: 15000 });
  const persistence = JSON.parse(await page.locator('#summary').textContent());
  await onReport('audio-persistence-check', persistence);
  assert.equal(persistence.results.length, 1);
  assert.equal(persistence.results[0].status, 'pass', JSON.stringify(persistence.results[0]));
  assert.equal(persistence.results[0].details.testTakeRemoved, true);
  assert.deepEqual(pageErrors, [], `Uncaught browser errors: ${pageErrors.join('; ')}`);
  assert.deepEqual(externalRequests, [], 'Audio verification made a request outside the local app origin.');
  return { main, persistence };
}
