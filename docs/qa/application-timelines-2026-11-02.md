# Application and booking timelines

The November 2, 2026 public provider snapshot contains booking windows in `schedule_type.advance_notice` and application instructions in several `eligibility_reqs` records. It does not contain structured application processing times. For example, LINK has an application instruction and a 1–7 day booking window; Mobility Matters has a seven-day booking notice but no explicit application instruction in its current eligibility text. Booking notice alone must not be presented as enrollment processing time.

## Storage

Use the existing `providers.booking` JSON field. No new table, column, migration, or bulk provider update is required. Preserve the existing booking method, contact details, and other keys, and optionally add:

```json
{
  "method": "call",
  "details": "Existing provider booking contact",
  "application": {
    "required": true,
    "processing_time": {
      "kind": "up_to",
      "value": 30,
      "unit": "calendar_days"
    },
    "instructions": "Provider-confirmed application steps",
    "source_type": "website",
    "source_url": "https://provider.example/application",
    "verified_at": "2026-11-02"
  }
}
```

This is a format example, not information to import into a provider record. The example's 30 days is not a verified duration for any provider. Omit unknown application keys; do not replace unknown values with `false`, a universal duration, or a booking interval. `required: false` must mean the provider confirmed no application is required. A source may be an official application page, phone call, email, or another recorded source. Use `source_notes` for confirmation details and record the verification date.

## Administrator form

Administrators do not need to write or edit JSON for booking/application information. The editor offers:

- Booking method and whether an application is required: selection controls, with explicit unknown choices.
- Processing time: Not yet confirmed, Same day, About, A range, Up to, or At least.
- Positive whole-number inputs for a single amount or minimum/maximum, plus calendar days, business days, weeks, or months.
- A preview of the text riders will see. Empty, negative, fractional, and reversed numeric ranges block saving until corrected.
- A source-type selection, optional source link/notes, a date picker, and a Use today's date button. Dates are never filled in automatically without the administrator's action.

Saving automatically builds the existing booking JSON and preserves unrelated contact and application metadata. Selecting no application removes its processing time. Unknown timing stays absent, rather than becoming zero. Old text-based processing times remain readable and are preserved as Keep existing wording until replaced with numeric choices.

Stored processing times use `kind: estimate|up_to|at_least` with `value` and `unit`; `kind: range` with `minimum`, `maximum`, and `unit`; or `kind: same_day`. These require no new database columns. Rider cards and chat retain the chosen qualifier and distinguish business days from calendar days.

## Rider behavior

- Show application requirements, application processing time, and booking notice separately in provider cards and the provider results panel.
- Use an explicit `booking.application.required` flag when available. Otherwise, recognize explicit existing application instructions; lack of an instruction leaves the requirement unknown.
- If processing time is missing, show “Contact the provider to confirm processing time.”
- Do not infer that a possible eligibility match means enrollment approval, an available ride, or immediate booking.
- Show provider-specific local and regional booking windows as recorded. Do not convert a range such as 1–7 days into an invented seven-day deadline.
- Do not show paratransit enrollment warnings on fixed-route providers.
- The chat uses the same existing provider data and distinguishes application processing from reservation notice. It must not invent application duration or waitlist status, or ask about ADA approval.

## Data to collect later

For each provider, verify whether an application is required, its processing time, application steps, an information source, and the date checked. Start with LINK Paratransit, Mobility Matters, and frequently recommended city programs. No data needs to be filled in before releasing the unknown-time fallback.

## Validation

Use the project's supported Node.js runtime. From `infra`, run `node --import tsx --test ../tests/providers/application-timeline.test.ts` for data interpretation, numeric conversion/validation, and metadata preservation. With the local development server running on port 43111, run `node tests/chat/application-timelines.mjs` and `node tests/providers/booking-editor.mjs` from the repository root. The browser tests stub external requests and do not update production records. They cover desktop/phone cards and editor load, numeric/select input, validation, generated JSON, previews, save/reopen, clearing to unknown, and legacy text preservation. Frontend/backend type checks, backend regressions, the production build, and the secret scan are also required.
