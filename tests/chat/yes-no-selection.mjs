// Local UI regression with all external services stubbed.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const baseUrl = process.argv[2] || 'http://127.0.0.1:43111/';
const options = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }, { value: 'declined', label: 'Would rather not say' }];
const questions = [{ id: 'disability-question', question: 'Do you have a disability?' }, { id: 'veteran-question', question: 'Are you a veteran?' }];
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 320, height: 568 }]) {
    const page = await browser.newPage({ viewport });
    const requests = [];
    const answers = new Map();
    let failFirst = true;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(baseUrl).origin) return route.continue();
      if (url.pathname.endsWith('/health')) return route.fulfill({ json: { status: 'ok' } });
      if (url.pathname.endsWith('/conversations')) return route.fulfill({ json: { id: 'binary-test', messages: [] } });
      if (url.pathname.endsWith('/chat')) {
        const body = route.request().postDataJSON(); requests.push(body);
        if (body.yes_no_answer) {
          await new Promise(resolve => setTimeout(resolve, 150));
          if (failFirst) { failFirst = false; return route.fulfill({ status: 500, json: { error: 'Please try your answer again.' } }); }
          answers.set(body.yes_no_answer.question_id, body.yes_no_answer.answer);
          return route.fulfill({ json: { message: 'Your answer has been saved.', attachments: [], binary_answers: [...answers].map(([id, answer]) => ({ id, answer })) } });
        }
        return route.fulfill({ json: { message: 'Please choose an answer below.', attachments: [{ type: 'yes_no_choices', data: { questions, options } }] } });
      }
      return route.fulfill({ json: [] });
    });
    await page.goto(baseUrl);
    await page.getByRole('button', { name: 'Get started', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#chat-question')?.disabled);
    const input = page.getByRole('textbox', { name: 'Your question', exact: true });
    await input.fill('Check my eligibility');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const groups = page.locator('[data-yes-no-choices]');
    await groups.first().waitFor();
    assert.equal(await groups.count(), 2);
    const disability = page.getByRole('group', { name: questions[0].question, exact: true });
    const veteran = page.getByRole('group', { name: questions[1].question, exact: true });
    assert.equal(await disability.getByRole('button').count(), 3);
    assert.equal(await disability.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    // Every heading must be inside the white card, including on narrow screens.
    assert.equal(await disability.evaluate(el => { const card = el.getBoundingClientRect(); const title = el.querySelector('h3').getBoundingClientRect(); return title.top >= card.top && title.bottom <= card.bottom; }), true);
    await disability.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/optimat-yes-no-options-${viewport.width}.png` });
    await input.fill('Keep my draft');
    await disability.getByRole('button', { name: 'Yes', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('alert').filter({ hasText: 'Please try your answer again' }).waitFor();
    assert.equal(await disability.getByRole('button', { name: 'Yes', exact: true }).isEnabled(), true);
    for (const option of options) {
      await disability.getByRole('button', { name: option.label, exact: true }).click();
      await disability.getByRole('button', { name: `${option.label} · Selected`, exact: true }).waitFor();
      assert.deepEqual(requests.at(-1).yes_no_answer, { question_id: questions[0].id, answer: option.value });
      assert.equal(requests.at(-1).message, `Question: ${questions[0].question} Answer: ${option.label}.`);
      assert.equal(await input.inputValue(), 'Keep my draft');
    }
    await veteran.getByRole('button', { name: 'No', exact: true }).click();
    await veteran.getByRole('button', { name: 'No · Selected', exact: true }).waitFor();
    assert.equal(requests.at(-1).yes_no_answer.question_id, questions[1].id);
    assert.equal(await disability.getByRole('button', { pressed: true }).count(), 1);
    assert.equal(await veteran.getByRole('button', { pressed: true }).count(), 1);
    await page.screenshot({ path: `/tmp/optimat-yes-no-${viewport.width}.png` });
    await page.getByRole('button', { name: 'New Chat', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#chat-question')?.disabled);
    assert.equal(await groups.count(), 0);
    console.log(`PASS ${viewport.width}: three options, multiple questions, keyboard, retry, draft preservation, corrections, card containment, reset`);
    await page.close();
  }
} finally { await browser.close(); }
