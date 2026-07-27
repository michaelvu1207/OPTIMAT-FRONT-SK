# API snapshots — point-in-time, not current

`snapshot-supabase-*.json` files here are captures from `tests/api-harness.mjs --snapshot`,
timestamped in the filename. They are a **record of what the API returned on that date**, useful for
diffing a backend migration. They are not a description of current production data, and they are not
committed (see `.gitignore`).

**Do not analyse provider behaviour from these files.** The 2026-03-30 captures store
`eligibility_reqs` in the older structured-rule shape; production has since moved to prose. Reading
them as current produced a confident bug report on 2026-07-27 about AND/OR eligibility handling that
did not exist in live data.

To ask a question about how providers behave today, query production instead:

```bash
KEY=$(grep VITE_SUPABASE_ANON_KEY ../../.env | cut -d= -f2)
curl -s "https://htjohidcoyfuwfjecazu.supabase.co/functions/v1/providers?limit=500" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
```

To score assistant behaviour, use `tests/chat/eval.mjs`, which runs against a live deployment.
