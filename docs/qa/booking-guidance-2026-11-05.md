# Named-provider application and booking guidance

The screenshot replay still produced a long answer implying that prior enrollment could make a next-day ride possible despite a recorded seven-day reservation notice. Prompt instructions alone did not prevent this contradiction.

Named-provider application/timeline questions now use a bounded response built directly from the current public provider record. The response has three bullets: booking notice, first-ride requirements and processing time, and one contact. Unknown application requirements remain unknown, even when inquiry instructions mention a coordinator. Application processing time is never substituted for booking notice. An unambiguous recorded notice longer than one calendar day produces the same next-day warning for new and already-enrolled riders. Other notice formats retain provider confirmation rather than guessing availability.

The bounded path covers explicit Mobility Matters, LINK Paratransit and the two Walnut Creek Lyft pass names. Multi-provider comparisons and requests containing a pickup-to-destination route keep the existing model flow. Lookup failure or ambiguous records also retain the existing flow. This does not guarantee concise prose for every possible phrasing. No provider records, credentials, frontend code or external search services are changed.

Validation: 107 backend tests passed; backend TypeScript check passed. Added cases cover the original screenshot question, an already-enrolled rider, unknown versus confirmed application requirements, recorded processing time, missing/short/ambiguous booking notice, and unrelated route or comparison requests.

Manual replay prompt:

> I am 75 and live in Danville. I have never used Mobility Matters. Can I get a ride tomorrow, or do I need to apply and book in advance?

Expected: three concise bullets, a next-day warning independent of enrollment when the record says seven days, no invented application duration or requirement, and a single contact. Provider details remain collapsed.
