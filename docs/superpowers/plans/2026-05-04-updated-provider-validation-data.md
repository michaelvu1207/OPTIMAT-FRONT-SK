# Updated Provider Validation Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update backend provider data so `eligibility_reqs`, `service_zone`, and `fare` reflect columns C, E, and G from `/Users/maikyon/Downloads/OPTIMAT Provider Validation Updated Providers.csv`, including the two newly validated Walnut Creek Lyft providers.

**Architecture:** Keep the existing AWS/Aurora migration path: `scripts/migrate-providers.mjs` transforms CSV rows, invokes the deployed `db-setup` Lambda, and the Lambda overwrites `optimat.providers` inside a transaction with orphan checks. Add a focused validation script so the CSV-to-provider transform can be checked before any database write. Avoid schema changes; this is a data migration and prompt/list refresh.

**Tech Stack:** Node.js ESM scripts, `csv-parse`, AWS CLI Lambda invocation, Aurora PostgreSQL table `optimat.providers`, Svelte/Supabase frontend consumers.

---

## Current Backend Findings

- Provider records live in `optimat.providers`; relevant columns are JSONB fields `eligibility_reqs`, `fare`, and `service_zone`.
- The canonical backend writer is `scripts/migrate-providers.mjs`.
- The Lambda action that writes data is in `infra/lambda/db-setup/index.ts`, action `migrate-providers`.
- The existing migration currently reads `/Users/maikyon/Downloads/OPTIMAT Provider Validation.csv`, not the updated providers CSV.
- The current migration already maps CSV columns C, E, and G by index:
  - C, `row[2]`: `Eligibility (provider website)` -> `eligibility_reqs`
  - E, `row[4]`: `Service Area (provider website)` -> `service_zone`
  - G, `row[6]`: `Cost (provider website)` -> `fare`
- The updated CSV has 29 rows.
- Newly added rows in the updated CSV:
  - `Walnut Creek Lyft Self Access Pass`
  - `Walnut Creek Lyft Concierge Pass`
  - `Walnut Creek Mini Bus`
  - `WestCAT Senior Dial-A-Ride`
  - `County Connection`
- Removed or renamed rows compared with the old CSV:
  - `County Connection (weekday)` and `County Connection (weekend)` are now `County Connection`
  - `Walnut Creek Lyft Rideshare` is replaced by the two specific Walnut Creek Lyft pass providers
  - `Walnut Creek Seniors Club Mini-Bus` is now `Walnut Creek Mini Bus`
  - `WestCAT Dial-A-Ride` is now `WestCAT Senior Dial-A-Ride`
  - `Arc Contra Costa (Visitability)`, `Centers for Elders Independence (El Sobrante)`, and `Choice in Aging` are absent from the updated CSV and need confirmation before deletion
- `supabase/functions/chat/index.ts` has a hardcoded provider-name allowlist that must be updated if provider names change.
- Follow-up data-fill scripts reference old names and should be updated or retired:
  - `scripts/fill-remaining.mjs`
  - `scripts/fix-vague-zones.mjs`

## Files To Modify

- Modify: `scripts/migrate-providers.mjs`
  - Point to the updated CSV.
  - Add a configurable `--csv <path>` option.
  - Update manual name mapping for renamed providers.
  - Preserve or intentionally retire old provider IDs.
  - Improve fare parsing for membership/subsidy text instead of reducing it to only `$60`.
  - Parse senior/disabled/resident eligibility without dropping multiple requirements.
  - Generate service zones from column E for the new Walnut Creek Lyft providers.

- Create: `scripts/validate-updated-providers.mjs`
  - Parse the updated CSV.
  - Build transformed provider records without invoking AWS.
  - Assert expected provider names and key field values for the updated rows.
  - Emit a compact validation report.

- Modify: `scripts/package.json`
  - Add scripts for validation and dry-run against the updated CSV.

- Modify: `supabase/functions/chat/index.ts`
  - Replace old hardcoded provider names with the updated set.

- Modify: `scripts/fill-remaining.mjs`
  - Replace old Walnut Creek and WestCAT names, or remove fills for providers no longer present.

- Modify: `scripts/fix-vague-zones.mjs`
  - Replace `Walnut Creek Lyft Rideshare` with both new Walnut Creek Lyft providers.
  - Use cities from column E: `Walnut Creek`, `Concord`, `Clayton`, `Pleasant Hill`, `Martinez`.

- Optional Modify: `README.md` or `scripts/README.md`
  - Document the provider data refresh procedure.

## Provider ID Policy

Use stable IDs for renamed providers when they are clear continuations:

```text
County Connection (weekday/weekend) -> County Connection
Walnut Creek Seniors Club Mini-Bus -> Walnut Creek Mini Bus
WestCAT Dial-A-Ride -> WestCAT Senior Dial-A-Ride
```

Assign new IDs for genuinely new providers:

```text
Walnut Creek Lyft Self Access Pass
Walnut Creek Lyft Concierge Pass
```

Do not silently delete these three providers just because they are absent from the updated CSV until the product owner confirms they should be removed:

```text
Arc Contra Costa (Visitability)
Centers for Elders Independence (El Sobrante)
Choice in Aging
```

If they should be removed, run the orphan check first and document the dependent references returned by the Lambda.

---

### Task 1: Add Updated CSV Validation Script

**Files:**
- Create: `scripts/validate-updated-providers.mjs`
- Modify: `scripts/package.json`

- [ ] **Step 1: Create a validation script**

Create `scripts/validate-updated-providers.mjs` with this behavior:

```js
#!/usr/bin/env node
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';

const CSV_PATH = process.argv[2] || '/Users/maikyon/Downloads/OPTIMAT Provider Validation Updated Providers.csv';

const rows = parse(fs.readFileSync(CSV_PATH, 'utf8'), {
  columns: true,
  skip_empty_lines: true,
  relax_quotes: true,
  trim: true,
});

const byName = new Map(rows.map((row) => [row['Provider Name'], row]));

const requiredNames = [
  'Walnut Creek Lyft Self Access Pass',
  'Walnut Creek Lyft Concierge Pass',
  'Walnut Creek Mini Bus',
  'WestCAT Senior Dial-A-Ride',
  'County Connection',
];

const failures = [];
for (const name of requiredNames) {
  if (!byName.has(name)) failures.push(`Missing required provider row: ${name}`);
}

function assertField(name, column, expectedSubstring) {
  const value = byName.get(name)?.[column] || '';
  if (!value.includes(expectedSubstring)) {
    failures.push(`${name} column "${column}" did not include "${expectedSubstring}". Actual: ${value}`);
  }
}

assertField('Walnut Creek Lyft Self Access Pass', 'Eligibility (provider website)', 'Resident of Walnut Creek');
assertField('Walnut Creek Lyft Self Access Pass', 'Service Area (provider website)', 'Martinez');
assertField('Walnut Creek Lyft Self Access Pass', 'Cost (provider website)', '$60 membership fee');
assertField('Walnut Creek Lyft Concierge Pass', 'Eligibility (provider website)', 'Unable to schedule rides through Lyft app');
assertField('Walnut Creek Lyft Concierge Pass', 'Cost (provider website)', '10 free trips per month');

console.log(`Validated ${rows.length} provider rows from ${CSV_PATH}`);
console.log(`Provider names:\n${rows.map((row) => `- ${row['Provider Name']}`).join('\n')}`);

if (failures.length > 0) {
  console.error(`\nValidation failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  process.exit(1);
}

console.log('\nValidation passed.');
```

- [ ] **Step 2: Add package scripts**

Modify `scripts/package.json`:

```json
{
  "scripts": {
    "migrate-providers:dry": "node migrate-providers.mjs",
    "migrate-providers:run": "node migrate-providers.mjs --execute",
    "providers:validate-updated": "node validate-updated-providers.mjs",
    "migrate-providers:updated-dry": "node migrate-providers.mjs --csv '/Users/maikyon/Downloads/OPTIMAT Provider Validation Updated Providers.csv'",
    "migrate-providers:updated-run": "node migrate-providers.mjs --csv '/Users/maikyon/Downloads/OPTIMAT Provider Validation Updated Providers.csv' --execute"
  }
}
```

- [ ] **Step 3: Run validation**

Run:

```bash
cd /Users/maikyon/Documents/Programming/OPTIMAT-FRONT-SK/scripts
npm run providers:validate-updated
```

Expected:

```text
Validated 29 provider rows from /Users/maikyon/Downloads/OPTIMAT Provider Validation Updated Providers.csv
Validation passed.
```

- [ ] **Step 4: Commit**

Run:

```bash
git add scripts/validate-updated-providers.mjs scripts/package.json
git commit -m "chore: validate updated provider CSV"
```

---

### Task 2: Update Provider CSV Migration Inputs And Name Mapping

**Files:**
- Modify: `scripts/migrate-providers.mjs`

- [ ] **Step 1: Add `--csv` support**

Replace the fixed CSV path block with this logic:

```js
function getArgValue(flagName) {
  const idx = process.argv.indexOf(flagName);
  if (idx === -1) return null;
  return process.argv[idx + 1] || null;
}

const CSV_PATH =
  getArgValue('--csv') ||
  '/Users/maikyon/Downloads/OPTIMAT Provider Validation Updated Providers.csv';
```

- [ ] **Step 2: Update manual name mapping**

Replace the current `MANUAL_NAME_MAP` entries for renamed providers with:

```js
const MANUAL_NAME_MAP = {
  'County Connection': 'County Connection',
  'County Connection (weekday)': 'County Connection',
  'County Connection (weekend)': '__MERGE_WITH_WEEKDAY__',
  'Richmond R-Transit': 'R-Transit (Richmond)',
  'El Cerrito Easy Ride Paratransit Services': 'Easy Ride Paratransit Services (El Cerrito)',
  'San Ramon Go San Ramon': 'Go San Ramon!',
  'San Ramon Senior Express Van': 'Senior Express Van (San Ramon)',
  'Orinda Seniors Around Town': 'Seniors Around Town (Orinda)',
  'County Connection LINK': 'LINK Paratransit',
  'Walnut Creek Seniors Club Mini-Bus': "Walnut Creek Senior's Club Mini-Bus",
  'Walnut Creek Mini Bus': "Walnut Creek Senior's Club Mini-Bus",
  'WestCAT Senior Dial-A-Ride': 'WestCAT Dial-A-Ride',
  'Wheels Go Tri-Valley': null,
  'Richmond Moves': null,
  'Rossmoor Dial-A-Bus': null,
  'Walnut Creek Lyft Self Access Pass': null,
  'Walnut Creek Lyft Concierge Pass': null,
};
```

If product wants visible names to match the updated CSV exactly, map `Walnut Creek Mini Bus` to itself and preserve the old ID by adding a provider-ID alias instead of mapping to the old display name.

- [ ] **Step 3: Preserve old provider IDs for renamed rows**

Add a provider ID alias map if display names should change:

```js
const PROVIDER_ID_NAME_ALIASES = {
  'Walnut Creek Mini Bus': "Walnut Creek Senior's Club Mini-Bus",
  'WestCAT Senior Dial-A-Ride': 'WestCAT Dial-A-Ride',
};
```

Use it inside `resolveProvider(csvName)`:

```js
const lookupName = PROVIDER_ID_NAME_ALIASES[csvName] ?? csvName;
const dbRow = dbByName.get(lookupName) ?? null;
```

Keep `providerName` as the CSV name when the backend should expose the updated name.

- [ ] **Step 4: Run dry-run**

Run:

```bash
cd /Users/maikyon/Documents/Programming/OPTIMAT-FRONT-SK/scripts
npm run migrate-providers:updated-dry
```

Expected:

```text
Total providers to write: 29
[new ids] Walnut Creek Lyft Self Access Pass
[new ids] Walnut Creek Lyft Concierge Pass
```

- [ ] **Step 5: Commit**

Run:

```bash
git add scripts/migrate-providers.mjs
git commit -m "chore: migrate providers from updated validation CSV"
```

---

### Task 3: Improve Eligibility And Fare Parsing For The Updated Rows

**Files:**
- Modify: `scripts/migrate-providers.mjs`
- Modify: `scripts/validate-updated-providers.mjs`

- [ ] **Step 1: Update eligibility parsing requirements**

Ensure these inputs produce both senior and disabled requirements and preserve resident information:

```js
parseEligibility('Senior (60+) or Disabled (18+). Resident of Walnut Creek, Concord, Clayton, Pleasant Hill or Martinez')
```

Expected normalized value:

```json
[
  { "type": "Senior" },
  { "type": "Disabled" },
  { "type": "Resident" }
]
```

- [ ] **Step 2: Update fare parsing for membership/subsidy language**

For fare strings that contain more than a simple fixed price, preserve the complete text:

```js
parseFare('$60 membership fee. Rider pays first $5 , the City of Walnut Creek will cover up to $10 per ride, rider pays additional charges for rides over $15.', existingFare)
```

Expected normalized value:

```json
{
  "type": "fixed",
  "cost": "$60 membership fee. Rider pays first $5 , the City of Walnut Creek will cover up to $10 per ride, rider pays additional charges for rides over $15."
}
```

For the Concierge Pass:

```json
{
  "type": "fixed",
  "cost": "$60 membership fee. 10 free trips per month"
}
```

- [ ] **Step 3: Extend validation script for normalized output**

Add checks that the dry-run output contains:

```text
Walnut Creek Lyft Self Access Pass eligibility_reqs includes Senior, Disabled, Resident
Walnut Creek Lyft Concierge Pass fare.cost includes 10 free trips per month
Walnut Creek Lyft Self Access Pass fare.cost includes rider pays additional charges
```

- [ ] **Step 4: Run validation and dry-run**

Run:

```bash
cd /Users/maikyon/Documents/Programming/OPTIMAT-FRONT-SK/scripts
npm run providers:validate-updated
npm run migrate-providers:updated-dry
```

Expected:

```text
Validation passed.
[DRY RUN] No data written.
```

- [ ] **Step 5: Commit**

Run:

```bash
git add scripts/migrate-providers.mjs scripts/validate-updated-providers.mjs
git commit -m "fix: preserve updated provider eligibility and fare text"
```

---

### Task 4: Update Service Zone Handling For New Walnut Creek Lyft Providers

**Files:**
- Modify: `scripts/migrate-providers.mjs`
- Modify: `scripts/fix-vague-zones.mjs`

- [ ] **Step 1: Confirm city parsing for column E**

For both new Lyft rows, parse:

```text
Walnut Creek, Concord, Clayton, Pleasant Hill, Martinez.
```

Expected city list:

```json
["Walnut Creek", "Concord", "Clayton", "Pleasant Hill", "Martinez"]
```

- [ ] **Step 2: Update vague-zone fallback map**

Replace the old `Walnut Creek Lyft Rideshare` entry in `scripts/fix-vague-zones.mjs` with:

```js
'Walnut Creek Lyft Self Access Pass': {
  cities: ['Walnut Creek', 'Concord', 'Clayton', 'Pleasant Hill', 'Martinez'],
  qualifier: 'Contra Costa County, California, USA',
},
'Walnut Creek Lyft Concierge Pass': {
  cities: ['Walnut Creek', 'Concord', 'Clayton', 'Pleasant Hill', 'Martinez'],
  qualifier: 'Contra Costa County, California, USA',
},
```

- [ ] **Step 3: Run dry-run without skipping boundaries**

Run:

```bash
cd /Users/maikyon/Documents/Programming/OPTIMAT-FRONT-SK/scripts
npm run migrate-providers:updated-dry
```

Expected:

```text
[service-zone] Fetching Nominatim boundaries for "Walnut Creek Lyft Self Access Pass": Walnut Creek, Concord, Clayton, Pleasant Hill, Martinez
[service-zone] Fetching Nominatim boundaries for "Walnut Creek Lyft Concierge Pass": Walnut Creek, Concord, Clayton, Pleasant Hill, Martinez
```

- [ ] **Step 4: Commit**

Run:

```bash
git add scripts/migrate-providers.mjs scripts/fix-vague-zones.mjs
git commit -m "fix: map service zones for Walnut Creek Lyft passes"
```

---

### Task 5: Update Hardcoded Chat Provider Names

**Files:**
- Modify: `supabase/functions/chat/index.ts`

- [ ] **Step 1: Replace outdated provider allowlist entries**

In the provider-name list, replace:

```text
Arc Contra Costa (Vistability)
Centers for Elders Independence (El Sobrante)
Choice in Aging
County Connections
R-Transit with Lyft
Walnut Creek Senior's Club Mini-Bus
WestCAT Dial-A-Ride
```

with the final provider list from the updated migration. At minimum, add:

```text
County Connection
Walnut Creek Lyft Self Access Pass
Walnut Creek Lyft Concierge Pass
Walnut Creek Mini Bus
WestCAT Senior Dial-A-Ride
```

- [ ] **Step 2: Run frontend type check**

Run:

```bash
cd /Users/maikyon/Documents/Programming/OPTIMAT-FRONT-SK
npm run check
```

Expected:

```text
svelte-check found 0 errors and 0 warnings
```

- [ ] **Step 3: Commit**

Run:

```bash
git add supabase/functions/chat/index.ts
git commit -m "fix: refresh chat provider allowlist"
```

---

### Task 6: Execute Backend Data Update

**Files:**
- Runtime data update only
- Backup output: `scripts/backup/providers-backup-<timestamp>.json`

- [ ] **Step 1: Run final dry-run and save output**

Run:

```bash
cd /Users/maikyon/Documents/Programming/OPTIMAT-FRONT-SK/scripts
npm run migrate-providers:updated-dry
```

Expected:

```text
Total providers to write: 29
[DRY RUN] No data written.
```

- [ ] **Step 2: Run the production migration**

Run:

```bash
cd /Users/maikyon/Documents/Programming/OPTIMAT-FRONT-SK/scripts
npm run migrate-providers:updated-run
```

Expected:

```text
Deleted <previous count> existing providers
Inserted 29 new providers
Orphan check: OK
Migration Complete
```

If the migration returns orphaned provider IDs, do not rerun with `--force` until the impacted tables are reviewed:

```text
optimat.trip_record_pairs_raw
optimat.get_provider_info_calls
optimat.demand_response_manifest_review
```

- [ ] **Step 3: Commit backup if project policy wants migration backups tracked**

If backups are meant to be versioned:

```bash
git add scripts/backup/providers-backup-*.json
git commit -m "chore: back up providers before updated data migration"
```

If backups are local operational artifacts, do not commit them.

---

### Task 7: Verify API And Data Integrity

**Files:**
- No code changes expected

- [ ] **Step 1: Run provider API harness against AWS**

Run:

```bash
cd /Users/maikyon/Documents/Programming/OPTIMAT-FRONT-SK
node tests/api-harness.mjs --target aws --only providers
```

Expected:

```text
GET /providers passes
GET /providers/search?q=transit passes
GET /providers/map passes
POST /providers/filter passes
```

- [ ] **Step 2: Verify the two new providers are returned**

Run a provider search or API request that confirms:

```text
Walnut Creek Lyft Self Access Pass exists
Walnut Creek Lyft Concierge Pass exists
```

Each should have:

```json
{
  "eligibility_reqs": "Senior, Disabled, Resident",
  "service_zone": "FeatureCollection containing Walnut Creek, Concord, Clayton, Pleasant Hill, Martinez",
  "fare": "full cost text from column G"
}
```

- [ ] **Step 3: Verify old ambiguous provider no longer appears if product approved its removal**

Check:

```text
Walnut Creek Lyft Rideshare
```

Expected:

```text
Absent, replaced by Self Access Pass and Concierge Pass
```

- [ ] **Step 4: Capture final migration notes**

Record:

```text
CSV file used
timestamp of backup file
inserted provider count
new provider IDs for both Walnut Creek Lyft pass rows
any providers intentionally removed
```

---

## Open Decisions Before Execution

1. Confirm whether providers absent from the updated CSV should be deleted:

```text
Arc Contra Costa (Visitability)
Centers for Elders Independence (El Sobrante)
Choice in Aging
```

2. Confirm whether display names should exactly match the updated CSV:

```text
Walnut Creek Mini Bus
WestCAT Senior Dial-A-Ride
County Connection
```

3. Confirm whether the old generic provider should be removed or retained:

```text
Walnut Creek Lyft Rideshare
```

Recommended answer: remove it after both specific pass providers are inserted.

## Self-Review

- Spec coverage: The plan covers eligibility, service area, cost, and the two new Walnut Creek Lyft providers.
- Placeholder scan: No implementation step depends on an unspecified file or unnamed command.
- Type consistency: The plan uses existing backend field names: `eligibility_reqs`, `service_zone`, and `fare`.
- Data safety: The plan preserves provider IDs for renamed providers and relies on the existing Lambda transaction and orphan check before destructive table replacement.

