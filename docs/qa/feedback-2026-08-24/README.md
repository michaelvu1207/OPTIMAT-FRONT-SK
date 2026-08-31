# August 24 Chat Feedback — Before/After Evidence

This evidence set covers every scenario transcribed from the initial spreadsheet's **To be fixed notes
8/24/26** column.

Each recording is cropped to the submitted message, assistant response, and provider-card embeds; the map,
navigation, composer, and other application UI are excluded so the behavioral change remains readable.

- [Combined before/after summary reel](feedback-2026-08-24-before-after-summary.mp4)
- Fixture and expected disposition: [`tests/chat/feedback-2026-08-24.json`](../../../tests/chat/feedback-2026-08-24.json)
- Capture harness: [`tests/chat/feedback-2026-08-24-video-evidence.mjs`](../../../tests/chat/feedback-2026-08-24-video-evidence.mjs)

## What the after state demonstrates

- GeoJSON still filters source and destination.
- The LLM must assess every geographic/schedule candidate before cards appear.
- Residence and other rider facts are structured and persisted across turns.
- Unknown decisive facts produce a focused follow-up question instead of a guessed recommendation.
- Outbound and return legs may match different stored service intervals.
- Missing service hours remain visibly unconfirmed.
- Senior Express and One-Seat rows are not given fabricated outcomes while their data/policy questions remain open.

## Evidence index

| Scenario | Before | After | Side-by-side |
| --- | --- | --- | --- |
| WC-RESIDENCE | [video](before/WC-RESIDENCE.webm) | [video](after/WC-RESIDENCE.webm) | [comparison](comparisons/WC-RESIDENCE.mp4) |
| WC-65-DISABLED-ADA | [video](before/WC-65-DISABLED-ADA.webm) | [video](after/WC-65-DISABLED-ADA.webm) | [comparison](comparisons/WC-65-DISABLED-ADA.mp4) |
| WC-65-NOT-DISABLED | [video](before/WC-65-NOT-DISABLED.webm) | [video](after/WC-65-NOT-DISABLED.webm) | [comparison](comparisons/WC-65-NOT-DISABLED.mp4) |
| WC-55-NOT-DISABLED | [video](before/WC-55-NOT-DISABLED.webm) | [video](after/WC-55-NOT-DISABLED.webm) | [comparison](comparisons/WC-55-NOT-DISABLED.mp4) |
| WC-55-DISABLED-ADA | [video](before/WC-55-DISABLED-ADA.webm) | [video](after/WC-55-DISABLED-ADA.webm) | [comparison](comparisons/WC-55-DISABLED-ADA.mp4) |
| SR-65-DISABLED-ADA | [video](before/SR-65-DISABLED-ADA.webm) | [video](after/SR-65-DISABLED-ADA.webm) | [comparison](comparisons/SR-65-DISABLED-ADA.mp4) |
| SR-65-NOT-DISABLED | [video](before/SR-65-NOT-DISABLED.webm) | [video](after/SR-65-NOT-DISABLED.webm) | [comparison](comparisons/SR-65-NOT-DISABLED.mp4) |
| SR-55-NOT-DISABLED | [video](before/SR-55-NOT-DISABLED.webm) | [video](after/SR-55-NOT-DISABLED.webm) | [comparison](comparisons/SR-55-NOT-DISABLED.mp4) |
| SR-55-DISABLED-ADA | [video](before/SR-55-DISABLED-ADA.webm) | [video](after/SR-55-DISABLED-ADA.webm) | [comparison](comparisons/SR-55-DISABLED-ADA.mp4) |
| RICHMOND-65-NOT-ADA | [video](before/RICHMOND-65-NOT-ADA.webm) | [video](after/RICHMOND-65-NOT-ADA.webm) | [comparison](comparisons/RICHMOND-65-NOT-ADA.mp4) |
| RICHMOND-55-DISABLED-ADA | [video](before/RICHMOND-55-DISABLED-ADA.webm) | [video](after/RICHMOND-55-DISABLED-ADA.webm) | [comparison](comparisons/RICHMOND-55-DISABLED-ADA.mp4) |
| RICHMOND-WC-65-ADA | [video](before/RICHMOND-WC-65-ADA.webm) | [video](after/RICHMOND-WC-65-ADA.webm) | [comparison](comparisons/RICHMOND-WC-65-ADA.mp4) |
| RICHMOND-WC-65-NOT-DISABLED | [video](before/RICHMOND-WC-65-NOT-DISABLED.webm) | [video](after/RICHMOND-WC-65-NOT-DISABLED.webm) | [comparison](comparisons/RICHMOND-WC-65-NOT-DISABLED.mp4) |
| RICHMOND-WC-55-ADA | [video](before/RICHMOND-WC-55-ADA.webm) | [video](after/RICHMOND-WC-55-ADA.webm) | [comparison](comparisons/RICHMOND-WC-55-ADA.mp4) |

## Evidence scope

These are deterministic local UI recordings driven by the approved regression fixture. The harness asserts
the rendered response and provider names before saving each artifact. They prove the frontend presentation and
the intended before/after contract without mutating production conversations. After deployment, the same fixture
must be replayed against staging and production with the live LLM and provider database before final stakeholder
acceptance.

## Data and policy items intentionally not invented in code

- LINK's stored eligibility wording needs data-team correction to reflect ADA paratransit determination.
- Mobility Matters has additional provider qualifications missing from the current record.
- Senior Express Van's scheduled-return data must be confirmed for the reported noon–3 PM trips.
- Walnut Creek Mini Bus operating days need data-team confirmation.
- One-Seat is active, but participating-network behavior for the Richmond examples needs product/data confirmation.
