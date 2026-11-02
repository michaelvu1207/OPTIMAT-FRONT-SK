// Local dev-server regression; all provider reads and updates use fixtures.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] || 'http://127.0.0.1:43111/';
const fixture = {
  provider_id: 90001, provider_name: 'Example Application Program', provider_type: 'Non-ADA Paratransit',
  booking: { method: 'call', details: '925-555-0100', contact_note: 'Preserve existing contact metadata', application: { required: true, processing_time: 'Old confirmed value', source_note: 'Preserve existing application metadata' } },
};
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    let saved = null;
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(baseUrl).origin) return route.continue();
      if (url.pathname.endsWith('/providers/90001')) {
        if (route.request().method() === 'PUT') {
          saved = route.request().postDataJSON();
          return route.fulfill({ json: { ...fixture, ...saved } });
        }
        return route.fulfill({ json: fixture });
      }
      return route.fulfill({ json: [] });
    });
    await page.goto(`${baseUrl}#/provider-portal/info`);
    await page.evaluate(async provider => {
      const { setProvider } = await import('/src/lib/stores/providerSession.ts');
      setProvider(provider);
    }, fixture);
    await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
    const section = page.getByRole('region', { name: 'Initial application', exact: true });
    const editor = page.locator('[data-booking-editor]');
    const save = page.getByRole('button', { name: 'Save changes', exact: true });
    const time = section.getByLabel('How long does application processing take?', { exact: true });
    const requirement = section.getByLabel('Does the rider need to apply first?', { exact: true });
    assert.equal(await time.inputValue(), 'existing');
    assert.match(await section.innerText(), /Old confirmed value/);
    assert.equal(await editor.getByRole('button', { name: /JSON/ }).count(), 0, 'Normal booking edits must not require a JSON editor');
    await save.click();
    await page.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
    assert.equal(saved.booking.application.processing_time, 'Old confirmed value', 'Unrelated edits must preserve legacy processing text');
    await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
    await requirement.selectOption('true');
    await time.selectOption('up_to');
    assert.equal(await save.isDisabled(), true, 'Missing numbers must block saving');
    const amount = section.getByLabel('Number', { exact: true });
    await amount.fill('-1');
    assert.equal(await save.isDisabled(), true);
    await amount.fill('2.5');
    assert.equal(await save.isDisabled(), true);
    await amount.fill('30');
    await section.getByLabel('Time unit', { exact: true }).selectOption('calendar_days');
    await section.getByLabel('Application steps (optional)', { exact: true }).fill('Contact the application office before your first ride.');
    await section.getByLabel('How was this information confirmed?', { exact: true }).selectOption('phone');
    await section.getByLabel('Source link (optional)', { exact: true }).fill('https://provider.example/apply');
    await section.getByLabel('Confirmation notes (optional)', { exact: true }).fill('Confirmed with the application office.');
    await section.getByLabel('Date checked', { exact: true }).fill('2026-11-02');
    assert.match(await section.locator('[data-processing-preview]').innerText(), /Up to 30 calendar days/);
    assert.equal(await save.isEnabled(), true);
    assert.equal(await editor.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/optimat-application-editor-${viewport.width}.png` });
    await save.click();
    await page.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
    await page.getByText('Up to 30 calendar days', { exact: true }).waitFor();
    assert.equal(saved.booking.method, 'call');
    assert.equal(saved.booking.details, fixture.booking.details);
    assert.equal(saved.booking.contact_note, fixture.booking.contact_note);
    assert.equal(saved.booking.application.source_note, fixture.booking.application.source_note);
    assert.deepEqual(saved.booking.application.processing_time, { kind: 'up_to', value: 30, unit: 'calendar_days' });
    assert.equal(saved.booking.application.source_type, 'phone');
    assert.equal(saved.booking.application.source_notes, 'Confirmed with the application office.');
    assert.equal(saved.booking.application.verified_at, '2026-11-02');
    await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
    assert.equal(await time.inputValue(), 'up_to');
    assert.equal(await amount.inputValue(), '30');
    await time.selectOption('range');
    await section.getByLabel('Minimum', { exact: true }).fill('5');
    await section.getByLabel('Maximum', { exact: true }).fill('3');
    assert.equal(await save.isDisabled(), true, 'Reversed ranges must block saving');
    await section.getByLabel('Maximum', { exact: true }).fill('10');
    await section.getByLabel('Time unit', { exact: true }).selectOption('business_days');
    assert.match(await section.locator('[data-processing-preview]').innerText(), /5–10 business days/);
    await save.click();
    await page.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
    assert.deepEqual(saved.booking.application.processing_time, { kind: 'range', minimum: 5, maximum: 10, unit: 'business_days' });
    await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
    assert.equal(await section.getByLabel('Minimum', { exact: true }).inputValue(), '5');
    await time.selectOption('same_day');
    assert.equal(await section.getByRole('spinbutton').count(), 0);
    await save.click();
    await page.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
    assert.deepEqual(saved.booking.application.processing_time, { kind: 'same_day' });
    await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
    await requirement.selectOption('false');
    assert.equal(await time.count(), 0, 'No-application choice must hide unnecessary timing fields');
    await save.click();
    await page.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
    assert.equal(saved.booking.application.required, false);
    assert.equal(saved.booking.application.processing_time, undefined);
    await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
    await requirement.selectOption('');
    await time.selectOption('unknown');
    await save.click();
    await page.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
    assert.equal(saved.booking.application.required, undefined, 'Unknown must not become false');
    assert.equal(saved.booking.application.processing_time, undefined);
    assert.equal(saved.booking.application.source_note, fixture.booking.application.source_note);
    console.log(`PASS ${viewport.width}: numeric/select forms, structured JSON storage, validation, preview, reopen, same-day/unknown/no-application cases, legacy text and metadata preservation`);
    await page.close();
  }
} finally {
  await browser.close();
}
