<script lang="ts">
  import PageShell from '$lib/components/PageShell.svelte';

  const OPTIMAT_PROJECT_REF = 'htjohidcoyfuwfjecazu';
  const OPTIMAT_SUPABASE_URL = `https://${OPTIMAT_PROJECT_REF}.supabase.co`;
  const OPTIMAT_FUNCTIONS_BASE_URL = `${OPTIMAT_SUPABASE_URL}/functions/v1`;

  const toc = [
    { id: 'overview', label: 'Overview' },
    { id: 'auth', label: 'Base URL and Auth' },
    { id: 'conventions', label: 'Response Conventions' },
    { id: 'health', label: 'health' },
    { id: 'providers', label: 'providers' },
    { id: 'geocode', label: 'geocode' },
    { id: 'directions', label: 'directions' },
    { id: 'chat', label: 'chat' },
    { id: 'conversations', label: 'conversations' },
    { id: 'messages', label: 'messages' },
    { id: 'tool-calls', label: 'tool-calls' },
    { id: 'replay', label: 'replay' },
    { id: 'chat-examples', label: 'chat-examples' },
    { id: 'trip-records', label: 'trip-records' },
    { id: 'tri-delta-transit', label: 'tri-delta-transit' },
    { id: 'swagger', label: 'OpenAPI and Swagger' }
  ];

  const samples = {
    errorPayload: `{"error":"message","success":false,"timestamp":"..."}`,
    healthResponse: `{"status":"ok"}`,
    providersFilterBody: `{
  "source_address": "123 Main St, City",
  "destination_address": "456 Oak Ave, City",
  "provider_type": "Dial-a-Ride"
}`,
    providersFilterResponse: `{
  "data": [],
  "source_address": "...",
  "destination_address": "...",
  "origin": { "lat": 37.77, "lon": -122.41 },
  "destination": { "lat": 37.78, "lon": -122.42 },
  "public_transit": null
}`,
    geocodeResponse: `{
  "success": true,
  "formatted_address": "123 Main St, City, ST 94105",
  "lat": 37.7749,
  "lng": -122.4194,
  "place_id": "ChIJ..."
}`,
    directionsRequest: `{
  "origin": "123 Main St, City, ST",
  "destination": "456 Oak Ave, City, ST",
  "mode": "driving"
}`,
    directionsResponse: `{
  "success": true,
  "summary": "US-101 N",
  "distance_text": "5.2 mi",
  "distance_meters": 8369,
  "duration_text": "15 mins",
  "duration_seconds": 900,
  "polyline": "encoded_polyline",
  "legs": [],
  "warnings": []
}`,
    chatRequest: `{
  "conversation_id": "uuid",
  "message": "User prompt",
  "stream": true
}`,
    chatResponse: `{
  "message": "Assistant response",
  "attachments": [
    { "type": "provider_search", "data": {} }
  ]
}`,
    toolCallsGroupedResponse: `{
  "conversation_id": "uuid",
  "tool_calls": {
    "find_providers": [],
    "search_addresses": [],
    "get_provider_info": [],
    "general_provider_question": []
  }
}`,
    replayResponse: `{
  "conversation_id": "uuid",
  "title": "Conversation title",
  "created_at": "2025-01-01T00:00:00Z",
  "replay_config": { "autoAdvance": false, "delayMs": 2000 },
  "states": [
    {
      "sequence_number": 1,
      "message": { "role": "assistant", "content": "..." },
      "state_snapshot": { "providers": [], "addresses": [] },
      "ui_hints": { "show_providers": false }
    }
  ]
}`,
    chatExamplesCreateBody: `{
  "conversation_id": "uuid",
  "title": "Example title",
  "description": "Optional description",
  "category": "general",
  "tags": ["tag1", "tag2"]
}`,
    tripRecordsCommonParams: `{
  "provider_id": 123,
  "mock": true
}`,
    tripRecordsUploadBody: `{
  "records": "csv text",
  "provider_id": 123,
  "filename": "trips.csv"
}`,
    triDeltaRouteOverlayResponse: `{
  "trip_id": 42,
  "mode": "driving",
  "summary": "Route summary",
  "distance_meters": 12000,
  "duration_seconds": 1800,
  "polyline": "encoded_polyline",
  "warnings": []
}`
  };
</script>

<PageShell
  title="Data API Docs"
  description="Supabase Edge Functions endpoints and payloads"
  fullWidth={true}
>
  <div class="mx-auto max-w-5xl">
    <div class="mb-6 rounded-lg border border-border/60 bg-card p-4">
      <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div class="text-sm font-semibold">Quick navigation</div>
          <div class="text-xs text-muted-foreground">
            This page reflects the Edge Functions in this repo under <code>supabase/functions</code>.
          </div>
        </div>
        <nav class="flex flex-wrap gap-2">
          {#each toc as item}
            <a
              class="inline-flex items-center rounded-md border border-border/60 bg-background px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition"
              href={`#${item.id}`}
            >
              {item.label}
            </a>
          {/each}
        </nav>
      </div>
    </div>

    <article class="prose prose-sm dark:prose-invert max-w-none">
      <h2 id="overview">Overview</h2>
      <p>
        The frontend talks to Supabase Edge Functions using REST-style paths under
        <code>/functions/v1</code>. Each function is implemented in
        <code>supabase/functions/&lt;name&gt;/index.ts</code> and typically reads or writes
        the <code>optimat</code> Postgres schema.
      </p>

      <h2 id="auth">Base URL and Auth</h2>
      <ul>
        <li><strong>Base URL (OPTIMAT)</strong>: <code>{OPTIMAT_FUNCTIONS_BASE_URL}</code></li>
        <li><strong>Project ref</strong>: <code>{OPTIMAT_PROJECT_REF}</code></li>
        <li>
          <strong>Headers</strong>:
          <code>Authorization: Bearer &lt;access-token-or-anon-key&gt;</code>,
          <code>apikey: &lt;anon-key&gt;</code>,
          <code>Content-Type: application/json</code>
        </li>
        <li>
          <strong>JWT verification</strong>: <code>chat</code>, <code>chat-examples</code>, and <code>trip-records</code> are deployed with
          JWT verification enabled (use a user <code>access_token</code>).
        </li>
      </ul>

      <h2 id="conventions">Response Conventions</h2>
      <ul>
        <li><strong>JSON</strong>: All endpoints return JSON.</li>
        <li>
          <strong>Error payload</strong> (from <code>errorResponse()</code>):
          <code>{samples.errorPayload}</code>
        </li>
        <li><strong>CORS</strong>: OPTIONS preflight supported on all endpoints.</li>
      </ul>

      <h2 id="health">health</h2>
      <ul>
        <li><code>GET /health</code> - Simple health probe.</li>
      </ul>
      <pre><code class="language-json">{samples.healthResponse}</code></pre>

      <h2 id="providers">providers</h2>
      <ul>
        <li><code>GET /providers</code> - List providers. Returns <code>{"{"} "data": Provider[] {"}"}</code>.</li>
        <li><code>POST /providers/filter</code> - Filter by route + criteria.</li>
        <li><code>GET /providers/search?q=term</code> - Search providers by name.</li>
        <li><code>GET /providers/map</code> - Provider GeoJSON for map display.</li>
        <li><code>GET /providers/geocode?address=...</code> - Address geocode helper.</li>
        <li><code>GET /providers/:id</code> - Provider by <code>provider_id</code>.</li>
        <li><code>GET /providers/:id/service-zone</code> - Service zone GeoJSON.</li>
        <li><code>PUT /providers/:id</code> - Update provider fields.</li>
      </ul>
      <p><strong>Filter body (minimal)</strong></p>
      <pre><code class="language-json">{samples.providersFilterBody}</code></pre>
      <p><strong>Filter response (shape)</strong></p>
      <pre><code class="language-json">{samples.providersFilterResponse}</code></pre>

      <h2 id="geocode">geocode</h2>
      <ul>
        <li><code>GET /geocode?address=...</code> - Google Places text search.</li>
      </ul>
      <pre><code class="language-json">{samples.geocodeResponse}</code></pre>

      <h2 id="directions">directions</h2>
      <ul>
        <li><code>POST /directions</code> - Route directions for driving or transit.</li>
      </ul>
      <p><strong>Request body</strong></p>
      <pre><code class="language-json">{samples.directionsRequest}</code></pre>
      <p><strong>Response (shape)</strong></p>
      <pre><code class="language-json">{samples.directionsResponse}</code></pre>

      <h2 id="chat">chat</h2>
      <ul>
        <li><code>POST /chat</code> - Run the assistant on a conversation.</li>
      </ul>
      <p><strong>Request body</strong></p>
      <pre><code class="language-json">{samples.chatRequest}</code></pre>
      <p><strong>Response</strong></p>
      <pre><code class="language-json">{samples.chatResponse}</code></pre>
      <p>
        The current Edge Function returns JSON only; the frontend can fall back if SSE streaming is
        not available.
      </p>

      <h2 id="conversations">conversations</h2>
      <ul>
        <li><code>GET /conversations</code> - List conversations (paginated).</li>
        <li><code>POST /conversations</code> - Create a conversation.</li>
        <li><code>GET /conversations/:id</code> - Conversation with messages.</li>
        <li><code>PUT /conversations/:id</code> - Update title or metadata.</li>
        <li><code>DELETE /conversations/:id</code> - Delete conversation and related data.</li>
      </ul>

      <h2 id="messages">messages</h2>
      <ul>
        <li><code>GET /messages?conversation_id=uuid</code> - List messages (paginated).</li>
        <li><code>POST /messages</code> - Create a message.</li>
        <li><code>GET /messages/:id</code> - Get a single message.</li>
        <li><code>DELETE /messages/:id</code> - Delete a message.</li>
      </ul>

      <h2 id="tool-calls">tool-calls</h2>
      <ul>
        <li><code>GET /tool-calls?conversation_id=uuid</code> - All tool calls grouped by type.</li>
        <li><code>GET /tool-calls?conversation_id=uuid&amp;tool_name=find_providers</code> - Filter by type.</li>
        <li><code>GET /tool-calls/recent?conversation_id=uuid&amp;limit=25</code> - Recent calls.</li>
      </ul>
      <p><strong>Grouped response (shape)</strong></p>
      <pre><code class="language-json">{samples.toolCallsGroupedResponse}</code></pre>

      <h2 id="replay">replay</h2>
      <ul>
        <li><code>GET /replay?conversation_id=uuid</code> - Build replay states.</li>
        <li><code>POST /replay/save-as-example</code> - Save example + replay states.</li>
      </ul>
      <p><strong>Replay response (shape)</strong></p>
      <pre><code class="language-json">{samples.replayResponse}</code></pre>

      <h2 id="chat-examples">chat-examples</h2>
      <ul>
        <li><code>GET /chat-examples</code> - List examples (paginated).</li>
        <li><code>POST /chat-examples</code> - Create example from conversation.</li>
        <li><code>GET /chat-examples/:id</code> - Example metadata.</li>
        <li><code>GET /chat-examples/:id/with-states</code> - Example + states.</li>
        <li><code>PUT /chat-examples/:id</code> - Update example.</li>
        <li><code>DELETE /chat-examples/:id</code> - Delete example + states.</li>
        <li><code>POST /chat-examples/:id/regenerate-states</code> - Rebuild states.</li>
      </ul>
      <p><strong>Create example body</strong></p>
      <pre><code class="language-json">{samples.chatExamplesCreateBody}</code></pre>

      <h2 id="trip-records">trip-records</h2>
      <ul>
        <li><code>GET /trip-records/pairs</code> - List trip pairs.</li>
        <li><code>GET /trip-records/pairs-grouped</code> - Grouped outbound/return legs.</li>
        <li><code>GET /trip-records/stats</code> - Summary statistics.</li>
        <li><code>POST /trip-records/upload</code> - Upload CSV text payload.</li>
        <li><code>GET /trip-records/manifest/pairs</code> - Manifest trip pairs.</li>
        <li><code>GET /trip-records/manifest/pair-summaries</code> - Manifest daily summaries.</li>
      </ul>
      <p><strong>Common query params</strong></p>
      <pre><code class="language-json">{samples.tripRecordsCommonParams}</code></pre>
      <p><strong>Upload body</strong></p>
      <pre><code class="language-json">{samples.tripRecordsUploadBody}</code></pre>

      <h2 id="tri-delta-transit">tri-delta-transit</h2>
      <ul>
        <li><code>GET /tri-delta-transit/trips</code> - Historical trips.</li>
        <li><code>GET /tri-delta-transit/routes?mode=driving</code> - Route overlays.</li>
      </ul>
      <p><strong>Route overlay response (shape)</strong></p>
      <pre><code class="language-json">{samples.triDeltaRouteOverlayResponse}</code></pre>

      <h2 id="swagger">OpenAPI and Swagger</h2>
      <p>
        Supabase Edge Functions do not generate OpenAPI specs automatically, but you can absolutely
        use Swagger by maintaining your own <code>openapi.yaml</code> (or <code>openapi.json</code>)
        and hosting Swagger UI as a static page. A common approach is to store the spec in the repo
        and add a small Svelte route that loads it into Swagger UI, or serve the spec from an Edge
        Function and point Swagger UI at that URL.
      </p>
    </article>
  </div>
</PageShell>
