# Full tester conversation replay

Rendered July 13, 2026 after replaying every tester message against deployed Supabase chat function version 31.

## Result

- Four original conversations
- 46 tester turns replayed in original order
- 46 successful responses
- Zero failed or timed-out replay calls
- Original database gaps are labeled in the images

| Conversation | Original | Replayed after fixes | Tester turns | Image |
|---|---|---|---:|---|
| Walnut Creek → North Concord | `a8b13038-f96c-497c-a3f5-05ec24b5cc1a` | `c3e63204-484c-4234-98de-0f691d4e73c4` | 10 | `rendered/01-walnut-creek-concord-date-before-after.png` |
| San Francisco, Richmond, public transit | `6f4c2981-4812-4e8c-be8d-389e7c638583` | `cd07d202-e6f5-419e-8cc6-710d358bc36c` | 21 | `rendered/02-sf-richmond-public-transit-before-after.png` |
| Bay Point → DVC | `8d6a7a83-b0ec-4653-b676-a25416fcfe12` | `a5ea0a4a-c39e-430d-ac35-357a63166c43` | 8 | `rendered/03-bay-point-dvc-eligibility-before-after.png` |
| Richmond weekend/date | `0bca3f58-84a1-4fb6-935a-28069b41e836` | `f008307f-cfd1-4791-b97e-b9ab0acc1c46` | 7 | `rendered/04-richmond-weekend-date-before-after.png` |

The exact-message replay intentionally preserves later tester messages even when an improved earlier answer changes the natural follow-up. For example, the improved DVC response corrects Pleasant Hill immediately, but subsequent original tester replies are still sent verbatim so the before/after set is complete.

The rendering pass exposed two additional issues: an unnecessary Richmond-state clarification and an incorrect weekday before provider search. Both were fixed before the final Richmond replay by adding authoritative standalone date resolution and a deterministic date acknowledgment.
