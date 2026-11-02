// Run against the local dev server. All external API/map requests are stubbed.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] || 'http://127.0.0.1:43111/';
const options = [
  { id: 'under_18', label: 'Under 18' }, { id: '18_49', label: '18–49' },
  { id: '50_54', label: '50–54' }, { id: '55_59', label: '55–59' },
  { id: '60_64', label: '60–64' }, { id: '65_plus', label: '65+' },
];
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 320, height: 568 }]) {
    const page = await browser.newPage({ viewport });
    const requests = [];
    let rejectFirst = true;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(baseUrl).origin) return route.continue();
      if (url.pathname.endsWith('/health')) return route.fulfill({ json: { status: 'ok' } });
      if (url.pathname.endsWith('/conversations')) return route.fulfill({ json: { id: 'age-test', messages: [] } });
      if (url.pathname.endsWith('/chat')) {
        const body = route.request().postDataJSON();
        requests.push(body);
        if (body.age_range) {
          await new Promise(resolve => setTimeout(resolve, 150));
          if (rejectFirst) {
            rejectFirst = false;
            return route.fulfill({ status: 500, json: { error: 'Could not save age range. Please try again.' } });
          }
          return route.fulfill({ json: { message: 'Thanks. What city do you live in?', attachments: [], age_range: body.age_range } });
        }
        if (body.message === 'I am 70 years old.') return route.fulfill({ json: { message: 'Thanks for the correction.', attachments: [], age_range: null } });
        return route.fulfill({ json: { message: 'Which age range are you in?', attachments: [{ type: 'age_choices', data: { options } }], age_range: null } });
      }
      return route.fulfill({ json: [] });
    });
    await page.goto(baseUrl);
    await page.getByRole('button', { name: 'Get started', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Your question', exact: true });
    await page.waitForFunction(() => !document.querySelector('#chat-question')?.disabled);
    await input.fill('I need a ride');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const choices = page.locator('[data-age-choices]');
    await choices.waitFor();
    assert.equal(await choices.getByRole('button').count(), 6);
    assert.equal(await choices.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await choices.scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
    await page.screenshot({ path: `/tmp/optimat-age-choices-${viewport.width}.png` });
    await input.fill('Keep my draft');
    const band = choices.getByRole('button', { name: '60–64', exact: true });
    await band.focus();
    await page.keyboard.press('Enter');
    await choices.getByRole('button', { name: '60–64, confirming', exact: true }).waitFor();
    assert.equal(await choices.getByRole('button', { name: '65+', exact: true }).isDisabled(), true);
    await page.getByRole('alert').filter({ hasText: 'Could not save age range' }).waitFor();
    assert.equal(await band.isEnabled(), true);
    await band.click();
    await choices.getByRole('button', { name: '60–64, selected', exact: true }).waitFor();
    assert.equal(requests[2].message, 'My age range is 60–64.');
    assert.equal(requests[2].age_range, '60_64');
    assert.equal(requests[2].conversation_id, 'age-test');
    assert.equal(await input.inputValue(), 'Keep my draft');
    for (const option of options.filter(x => x.id !== '60_64')) {
      await choices.getByRole('button', { name: option.label, exact: true }).click();
      await choices.getByRole('button', { name: `${option.label}, selected`, exact: true }).waitFor();
      assert.equal(requests.at(-1).age_range, option.id);
      assert.equal(requests.at(-1).message, `My age range is ${option.label}.`);
      assert.equal(await input.inputValue(), 'Keep my draft');
      assert.equal(await choices.getByRole('button', { name: '60–64', exact: true }).isEnabled(), true);
    }
    assert.equal(requests.length, 8, 'One chat turn per selection attempt');
    await input.fill('I am 70 years old.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Thanks for the correction.', { exact: true }).waitFor();
    assert.equal(await choices.getByRole('button', { name: /, selected$/ }).count(), 0, 'Typed age corrections must clear stale band selection');
    await page.getByRole('button', { name: 'New Chat', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#chat-question')?.disabled);
    assert.equal(await page.locator('[data-age-choices]').count(), 0);
    console.log(`PASS ${viewport.width}: six age options, keyboard selection, structured band ID, draft preservation, retry, corrections, no clipping, new-chat reset`);
    await page.close();
  }
} finally {
  await browser.close();
}
