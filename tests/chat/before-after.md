# OPTIMAT chat regression: before and after

Validated July 13, 2026 in `America/Los_Angeles` against deployed Supabase chat function version 31.

## Evidence sources

- Historical production conversations: `a8b13038-f96c-497c-a3f5-05ec24b5cc1a`, `6f4c2981-4812-4e8c-be8d-389e7c638583`, `8d6a7a83-b0ec-4653-b676-a25416fcfe12`, `0bca3f58-84a1-4fb6-935a-28069b41e836`
- Final post-fix conversations: `df0cae6a-1450-4d41-ad27-5d145831e263`, `cb9e383e-c240-43c4-ba24-b1e080dde8a8`, `8dcefcad-ea0e-4875-bcc4-f7e9da09bc03`, `2e893372-c8d9-4812-8d13-908763b2ab70`, `761f63e4-4ef2-46d7-8e5d-90aba96653d3`, `07a50242-2fca-4f95-b285-f82c80a9ca46`
- Historical reproduction: `node tests/chat/replicate-before.mjs`
- Backend regression suite: `deno test --allow-env supabase/functions/chat/trip.test.ts supabase/functions/chat/responses.test.ts supabase/functions/chat/tools.test.ts`
- Frontend regression: `node tests/chat/frontend-regression.mjs <local-url>`

## Before and after

| Issue | Before | After |
|---|---|---|
| Composer focus | The rider had to click the message box after every response. | Automated browser test confirms initial focus and restored focus after success, cancellation, and errors; an intentional click outside the composer prevents focus from being stolen back. |
| “Tomorrow” date | On July 9, “tomorrow” became July 20. | Live response: “tomorrow (Tuesday, July 14, 2026)” on July 13. Fixed-clock regression confirms July 9 → July 10. |
| One-way trips | Search required a fake return time. | Live attachment: `trip_type: one_way`, `return_time: null`; no return question. |
| Binding constraint | The response mixed geography and service-hour possibilities, causing repeated time changes. | Coverage is checked first. A geography failure says changing the date/time cannot fix it and does not ask for date, time, eligibility, or return details. |
| Missing date | Search sometimes continued without asking for a travel date. | Live response explicitly asks: “What date do you need this ride?” before provider search. |
| Year/system date | July 21 was interpreted as 2025 and the follow-up timed out. | Server-side service clock resolves missing years in California time; live July 21, 2026 searches completed. Past dates are rejected explicitly. |
| General-resident eligibility | One-Seat and Mobility Matters were presented as providers. | Live result has zero eligible direct providers. One-Seat and Mobility Matters are in `excluded_providers`; fixed-route transit is fallback-only. |
| Invented trip date | A response invented December 20 without any date from the rider. | Provider search cannot run without `travel_date_raw`; the server resolves and echoes the normalized date. |
| DVC in Antioch | Providers were recommended before the system revealed DVC is in Pleasant Hill. | Live first response says the destination resolved to Pleasant Hill, not Antioch, and requests confirmation before searching. |
| Pseudo-booking | The assistant asked for name, address, and phone as if OPTIMAT would book. | R-Transit follow-up provides external phone/email/site, application requirements, and says the provider confirms the ride. No rider PII is requested. |
| Richmond clarification | The assistant asked whether Richmond meant Richmond, California. | Richmond defaults to California Bay Area context; the live Richmond request proceeded without a state question. |
| Richmond hangs | Four attempts timed out; the largest recorded provider tool result was 478,771 characters. | Live Richmond search completed in 13.955 seconds with a 5,733-character provider result. Geometry is never returned to the model/client. |
| Stop control | The spinner blocked all chat actions and offered no cancellation. | Stop button aborts the client request, preserves an in-progress draft, and restores focus. The browser regression also caught and fixed a stop-click/form-submit race. |
| Contact links | Phone, email, and website were plain text. | Browser regression found 2 `tel:`, 2 `mailto:`, and 2 HTTPS links in the rendered Richmond response. |

## Generated post-fix responses

### Cross-service-area request

> I couldn't find a direct provider in our current data whose service area covers both locations.  
> Pickup: Walnut Creek, CA  
> Destination: San Francisco, CA  
> Changing the date or time will not fix this coverage constraint, so I won't ask you for unnecessary return-trip details. Public transit may still be an option.

### Missing date

> Great! There are providers serving that route. Now I need one more piece of information to search for available rides: **What date do you need this ride?**

### DVC city mismatch

> “DVC, Antioch, California” resolved to 321 Golf Club Rd, Pleasant Hill, CA 94523, which is in Pleasant Hill, not Antioch. Please confirm the destination before I search providers.

### General resident from Bay Point to Antioch

> 4 providers cover the trip and requested schedule, but none match the eligibility information provided.  
> TDT Senior Paratransit: The rider does not match the provider's age 65+ requirement.  
> TDT ADA Paratransit: The rider does not match the provider's disability requirement.  
> One-Seat Regional Ride: The rider does not match the provider's disability requirement.  
> Public transit routing may still be available for this trip.

The structured result also excludes Mobility Matters and contains no eligible direct provider.

### Richmond

> Perfect! I found 2 eligible providers for your trip from Richmond City Hall to Kaiser Richmond on **Tuesday, July 21, 2026**, departing at noon.

The response lists R-Transit and Mobility Matters for this 68-year-old Richmond resident, excludes East Bay Paratransit because the rider said they were not ADA-certified, and provides active contact methods. The R-Transit handoff completed in 3.293 seconds.

## Automated verification summary

- 20 backend tests passed.
- Svelte check passed with zero errors; one unrelated pre-existing upload-panel accessibility warning remains.
- Production build passed.
- Browser test passed: Stop visible, composer enabled while waiting, draft preserved, focus restored, intentional click-out respected, no fake return request, and contact links active.
