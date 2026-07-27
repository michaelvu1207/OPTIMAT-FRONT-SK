<script lang="ts">
  import PageShell from '$lib/components/PageShell.svelte';

  const OPTIMAT_PROJECT_REF = 'htjohidcoyfuwfjecazu';
  const OPTIMAT_SUPABASE_URL = `https://${OPTIMAT_PROJECT_REF}.supabase.co`;

  const toc = [
    { id: 'overview', label: 'Overview' },
    { id: 'frontend', label: 'Frontend (SvelteKit + SPA Router)' },
    { id: 'api', label: 'API Layer (Supabase Edge Functions)' },
    { id: 'chatbot', label: 'Chatbot Pipeline (Claude + Tools)' },
    { id: 'tools', label: 'Chat Tools (Detailed)' },
    { id: 'data', label: 'Data Model (optimat schema)' },
    { id: 'deployment', label: 'Build & Deployment' },
    { id: 'security', label: 'Security Notes' }
  ];
</script>

<PageShell
  title="Architecture Docs"
  description="How the frontend, chatbot, and Supabase backend fit together"
  fullWidth={true}
>
  <div class="mx-auto max-w-5xl">
    <div class="mb-6 rounded-lg border border-border/60 bg-card p-4">
      <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div class="text-sm font-semibold">Quick navigation</div>
          <div class="text-xs text-muted-foreground">
            This page reflects the code in this repo (frontend + Supabase Edge Functions).
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
        OPTIMAT is a web app that behaves like a single-page application, so users can move between
        screens without full page reloads. The front end sends most requests to a backend API layer,
        which stores and reads data from a database and calls external services when needed (for
        example, chat and mapping services).
      </p>

      <div class="not-prose my-4 rounded-lg border border-border/60 bg-background p-3">
        <div class="text-xs font-semibold mb-2 text-muted-foreground">System diagram</div>
        <svg viewBox="0 0 980 330" class="w-full h-auto" role="img" aria-label="High level architecture diagram">
          <defs>
            <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
              <path d="M0,0 L10,3 L0,6 Z" fill="var(--muted-foreground)"></path>
            </marker>
          </defs>

          <!-- Client -->
          <rect x="30" y="40" width="260" height="110" rx="12" fill="var(--card)" stroke="var(--border)" />
          <text x="55" y="70" fill="var(--foreground)" font-size="14" font-weight="600">Browser</text>
          <text x="55" y="95" fill="var(--muted-foreground)" font-size="12">Web app shell</text>
          <text x="55" y="115" fill="var(--muted-foreground)" font-size="12">Single-page navigation (Map / Chat / ...)</text>
          <text x="55" y="135" fill="var(--muted-foreground)" font-size="12">User interface (maps + chat)</text>

          <!-- Backend platform -->
          <rect x="360" y="25" width="290" height="280" rx="12" fill="var(--card)" stroke="var(--border)" />
          <text x="385" y="55" fill="var(--foreground)" font-size="14" font-weight="600">Backend platform</text>
          <rect x="390" y="75" width="230" height="75" rx="10" fill="var(--background)" stroke="var(--border)" />
          <text x="405" y="100" fill="var(--foreground)" font-size="12" font-weight="600">API layer</text>
          <text x="405" y="120" fill="var(--muted-foreground)" font-size="11">chat, provider lookup, location, routing</text>
          <text x="405" y="138" fill="var(--muted-foreground)" font-size="11">conversations, messages, event logs</text>

          <rect x="390" y="170" width="230" height="105" rx="10" fill="var(--background)" stroke="var(--border)" />
          <text x="405" y="195" fill="var(--foreground)" font-size="12" font-weight="600">Database</text>
          <text x="405" y="215" fill="var(--muted-foreground)" font-size="11">provider records</text>
          <text x="405" y="232" fill="var(--muted-foreground)" font-size="11">conversations, messages</text>
          <text x="405" y="249" fill="var(--muted-foreground)" font-size="11">API/tool activity logs</text>

          <!-- External -->
          <rect x="715" y="40" width="235" height="110" rx="12" fill="var(--card)" stroke="var(--border)" />
          <text x="740" y="70" fill="var(--foreground)" font-size="14" font-weight="600">External services</text>
          <text x="740" y="95" fill="var(--muted-foreground)" font-size="12">AI services</text>
          <text x="740" y="115" fill="var(--muted-foreground)" font-size="12">mapping and geocoding services</text>

          <!-- Arrows -->
          <line x1="290" y1="95" x2="360" y2="95" stroke="var(--muted-foreground)" stroke-width="2" marker-end="url(#arrow)" />
          <text x="300" y="80" fill="var(--muted-foreground)" font-size="11">HTTP</text>

          <line x1="620" y1="105" x2="715" y2="95" stroke="var(--muted-foreground)" stroke-width="2" marker-end="url(#arrow)" />
          <text x="640" y="78" fill="var(--muted-foreground)" font-size="11">tooling + maps</text>

          <line x1="505" y1="150" x2="505" y2="170" stroke="var(--muted-foreground)" stroke-width="2" marker-end="url(#arrow)" />
          <text x="520" y="162" fill="var(--muted-foreground)" font-size="11">SQL</text>
        </svg>
      </div>

      <h2 id="frontend">Frontend (SvelteKit + SPA Router)</h2>
      <p>
        The app runs under SvelteKit, but server-side rendering is disabled (see
        <code>src/routes/+page.svelte</code>). The actual “pages” users navigate between are
        Svelte components registered in <code>src/routes.js</code> and rendered by
        <code>svelte-spa-router</code> inside <code>src/App.svelte</code>.
      </p>
      <ul>
        <li>
          <strong>Shell</strong>: SvelteKit provides the build/runtime; the entry route mounts the SPA.
        </li>
        <li>
          <strong>Navigation</strong>: <code>$lib/components/PageShell.svelte</code> renders the top bar and calls
          <code>push()</code> to update <code>window.location.hash</code>.
        </li>
        <li>
          <strong>Views</strong>: <code>src/routes/ChatView.svelte</code>, <code>src/routes/TripPairs.svelte</code>, etc.
        </li>
        <li>
          <strong>Maps</strong>: Leaflet via <code>sveaflet</code>, with pings/service zones managed by stores in <code>src/lib</code>.
        </li>
      </ul>

      <h2 id="api">API Layer (Supabase Edge Functions)</h2>
      <p>
        The frontend uses a thin API layer (<code>src/lib/api.ts</code>) which calls Supabase Edge Functions via
        <code>fetch()</code> (see <code>src/lib/supabase.ts</code>). The anon key is used as a bearer token for these calls.
      </p>
      <ul>
        <li>
          <strong>Function URL pattern</strong>: <code>{'{SUPABASE_URL}'}/functions/v1/&lt;path&gt;</code> (OPTIMAT:
          <code>{OPTIMAT_SUPABASE_URL}/functions/v1/&lt;path&gt;</code>)
        </li>
        <li>
          <strong>REST-ish routing</strong>: many functions implement subroutes by parsing the URL path (e.g. <code>providers/search</code>).
        </li>
        <li>
          <strong>Chat streaming</strong>: <code>streamChatResponse()</code> can handle SSE or fall back to JSON if the deployment doesn’t stream.
        </li>
      </ul>

      <h2 id="chatbot">Chatbot Pipeline (Claude + Tools)</h2>
      <p>
        The chatbot is implemented as a Supabase Edge Function (<code>supabase/functions/chat/index.ts</code>). It:
        reads the conversation history from Postgres, calls AWS Bedrock (Claude Haiku), optionally executes tool calls,
        persists the tool outputs, and returns a final assistant message plus attachments (used by the UI to show results).
      </p>

      <div class="not-prose my-4 rounded-lg border border-border/60 bg-background p-3">
        <div class="text-xs font-semibold mb-2 text-muted-foreground">Chat sequence (simplified)</div>
        <svg viewBox="0 0 980 280" class="w-full h-auto" role="img" aria-label="Chat request and tool-calling sequence diagram">
          <defs>
            <marker id="arrow2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
              <path d="M0,0 L10,3 L0,6 Z" fill="var(--muted-foreground)"></path>
            </marker>
          </defs>

          <!-- Lanes -->
          <text x="70" y="28" fill="var(--foreground)" font-size="12" font-weight="600">Browser</text>
          <line x1="90" y1="40" x2="90" y2="260" stroke="var(--border)" />

          <text x="300" y="28" fill="var(--foreground)" font-size="12" font-weight="600">Edge Function: chat</text>
          <line x1="330" y1="40" x2="330" y2="260" stroke="var(--border)" />

          <text x="545" y="28" fill="var(--foreground)" font-size="12" font-weight="600">Postgres (optimat)</text>
          <line x1="560" y1="40" x2="560" y2="260" stroke="var(--border)" />

          <text x="760" y="28" fill="var(--foreground)" font-size="12" font-weight="600">AWS Bedrock</text>
          <line x1="780" y1="40" x2="780" y2="260" stroke="var(--border)" />

          <!-- Messages -->
          <line x1="95" y1="70" x2="330" y2="70" stroke="var(--muted-foreground)" stroke-width="2" marker-end="url(#arrow2)" />
          <text x="115" y="62" fill="var(--muted-foreground)" font-size="11">POST /functions/v1/chat (message)</text>

          <line x1="330" y1="98" x2="560" y2="98" stroke="var(--muted-foreground)" stroke-width="2" marker-end="url(#arrow2)" />
          <text x="350" y="90" fill="var(--muted-foreground)" font-size="11">load conversation + messages</text>

          <line x1="330" y1="126" x2="560" y2="126" stroke="var(--muted-foreground)" stroke-width="2" marker-end="url(#arrow2)" />
          <text x="350" y="118" fill="var(--muted-foreground)" font-size="11">insert user message</text>

          <line x1="330" y1="156" x2="780" y2="156" stroke="var(--muted-foreground)" stroke-width="2" marker-end="url(#arrow2)" />
          <text x="350" y="148" fill="var(--muted-foreground)" font-size="11">Converse (system prompt + history + tools)</text>

          <line x1="780" y1="184" x2="330" y2="184" stroke="var(--muted-foreground)" stroke-width="2" marker-end="url(#arrow2)" />
          <text x="360" y="176" fill="var(--muted-foreground)" font-size="11">tool call request(s) + draft response</text>

          <line x1="330" y1="210" x2="560" y2="210" stroke="var(--muted-foreground)" stroke-width="2" marker-end="url(#arrow2)" />
          <text x="350" y="202" fill="var(--muted-foreground)" font-size="11">store tool call results + assistant message</text>

          <line x1="330" y1="238" x2="95" y2="238" stroke="var(--muted-foreground)" stroke-width="2" marker-end="url(#arrow2)" />
          <text x="110" y="230" fill="var(--muted-foreground)" font-size="11">JSON/SSE: message + attachments</text>
        </svg>
      </div>

      <p>
        Tool calls are persisted under dedicated tables (and can be queried by the UI via the
        <code>tool-calls</code> Edge Function), which enables replay, debugging, and showing structured results
        alongside the assistant’s natural language response.
      </p>

      <h2 id="tools">Chat Tools (Detailed)</h2>
      <p>
        Tools are defined in <code>supabase/functions/chat/tools.ts</code> as <code>toolDefinitions</code>. The chat loop
        converts them to Bedrock’s <code>toolConfig</code> format and executes requested tools via
        <code>executeTool()</code>. After each tool runs, results are (1) stored in Postgres for traceability and (2) returned
        to the UI as typed attachments on the assistant message.
      </p>

      <h3>Available tools</h3>
      <ul>
        <li><code>find_providers</code> → attachment <code>provider_search</code></li>
        <li><code>assess_eligibility</code> → attachment <code>provider_search</code></li>
        <li><code>search_addresses_from_user_query</code> → attachment <code>address_search</code></li>
        <li><code>general_provider_question</code> → attachment <code>web_search</code></li>
      </ul>

      <h3>Tool execution + persistence model</h3>
      <ul>
        <li>
          <strong>Execution</strong>: <code>executeTool(toolName, toolInput, supabase, googleMapsApiKey)</code> dispatches to the
          tool’s implementation.
        </li>
        <li>
          <strong>Persistence</strong>: <code>storeToolCall(...)</code> writes a row into a tool-specific table in the
          <code>optimat</code> schema (one table per tool).
        </li>
        <li>
          <strong>UI integration</strong>: successful tool results are also returned inline as attachments on the chat response.
          The chat UI reads these attachments (e.g. <code>provider_search</code>) to render cards, populate the map, etc.
        </li>
      </ul>

      <h3 id="tool-find-providers"><code>find_providers</code></h3>
      <p>
        Purpose: given origin + destination + times, return the paratransit providers whose service zones cover both points and
        whose service hours include both the departure and return times. Also fetches a “public transit” option for the same trip.
      </p>
      <ul>
        <li><strong>Inputs</strong>: <code>source_address</code>, <code>destination_address</code>, <code>departure_time</code>, <code>return_time</code> (required); optional <code>travel_date</code>, <code>schedule_type</code>, <code>provider_type</code>. Eligibility is returned as provider text for the chatbot to reason over, not submitted as a structured filter.</li>
        <li><strong>External calls</strong>:
          <ul>
            <li>Geocoding is done via Google Places “Text Search” (<code>places:searchText</code>) for each address.</li>
            <li>Public transit routing is fetched via Google Directions API (<code>mode=transit</code>).</li>
          </ul>
        </li>
        <li><strong>Database reads</strong>: loads all rows from <code>optimat.providers</code>.</li>
        <li><strong>Service zone filtering</strong>:
          <ul>
            <li>Each provider’s <code>service_zone</code> is treated as GeoJSON (<code>Polygon</code> or <code>MultiPolygon</code>).</li>
            <li>A point-in-polygon check is run for origin and destination; both must be inside the zone to match.</li>
          </ul>
        </li>
        <li><strong>Service hour filtering</strong>:
          <ul>
            <li>Times are parsed into minutes since midnight (supports <code>HH:MM</code>, <code>h:mm AM/PM</code>, <code>0530</code>, etc.).</li>
            <li>If a <code>travel_date</code> is provided, day-of-week is derived and compared against each service-hour entry’s day pattern.</li>
            <li>Overnight windows are supported (end time earlier than start time → treated as spanning midnight).</li>
          </ul>
        </li>
        <li><strong>Output shaping</strong>: <code>service_zone</code> is removed from each returned provider to keep responses lighter.</li>
        <li><strong>Persisted to</strong>: <code>optimat.find_providers_calls</code> (includes addresses, provider results, and <code>public_transit</code>).</li>
      </ul>

      <h3 id="tool-search-addresses"><code>search_addresses_from_user_query</code></h3>
      <p>
        Purpose: when the user says “take me to Walnut Creek BART” (or similar) without a precise address, this tool returns a
        list of candidate places/addresses with coordinates.
      </p>
      <ul>
        <li><strong>Inputs</strong>: <code>user_query</code> (required).</li>
        <li><strong>External calls</strong>: Google Places “Text Search” (<code>places:searchText</code>) returning display name, formatted address, and location.</li>
        <li><strong>Output</strong>: normalized <code>places[]</code> with <code>name</code>, <code>address</code>, and <code>{'{lat,lng}'}</code>.</li>
        <li><strong>Persisted to</strong>: <code>optimat.search_addresses_calls</code> (query + raw places payload).</li>
      </ul>

      <h3 id="tool-assess-eligibility"><code>assess_eligibility</code></h3>
      <p>
        Purpose: record the assistant’s eligibility verdict for each candidate <code>find_providers</code> returned, and assemble the
        rider-facing result from them. The server decides service area and hours; who qualifies is read off each provider’s own
        requirement text by the assistant, which can judge things a fixed rule cannot — that a rider in Alamo or Rodeo is a Contra
        Costa County resident, for instance.
      </p>
      <ul>
        <li><strong>Inputs</strong>: <code>assessments[]</code> of <code>provider_name</code>, <code>verdict</code>, <code>reason</code>, and optional <code>missing_fact</code>.</li>
        <li>
          <strong>Validation</strong>: every candidate from the last search must have a verdict, and every name must be one of them.
          An incomplete or invented call is rejected with the candidate list, so a provider is never dropped by omission.
        </li>
        <li><strong>Output</strong>: the search result with <code>data</code> (qualified), <code>verification_required</code>, and <code>excluded_providers</code> filled in — the shape the provider cards render from.</li>
        <li><strong>Persisted to</strong>: <code>optimat.find_providers_calls</code>, alongside the search it grades.</li>
      </ul>

      <h3 id="tool-general-provider-question"><code>general_provider_question</code></h3>
      <p>
        Purpose: answer questions that are not available in internal tables (policies, external provider info not stored in DB, etc.)
        by doing a web search and returning an answer with sources.
      </p>
      <ul>
        <li><strong>Inputs</strong>: <code>question</code> (required).</li>
        <li><strong>External calls</strong>: Tavily Search API (<code>POST https://api.tavily.com/search</code>) if <code>TAVILY_API_KEY</code> is configured.</li>
        <li><strong>Output</strong>: <code>answer</code> plus <code>sources[]</code> (title/url/snippet, truncated for size).</li>
        <li><strong>Persisted to</strong>: <code>optimat.general_question_calls</code> (answer + sources snapshot).</li>
      </ul>

      <h3>Secrets and runtime configuration (Edge)</h3>
      <ul>
        <li><strong>Chat model</strong>: <code>AWS_ACCESS_KEY_ID</code>, <code>AWS_SECRET_ACCESS_KEY</code>, <code>AWS_REGION</code></li>
        <li><strong>Maps/tools</strong>: <code>GOOGLE_MAPS_API_KEY</code></li>
        <li><strong>Web search</strong>: <code>TAVILY_API_KEY</code> (only needed for <code>general_provider_question</code>)</li>
        <li><strong>Database</strong>: <code>SUPABASE_URL</code>, <code>SUPABASE_SERVICE_ROLE_KEY</code> (chat uses service role via <code>createOptimatClient()</code>)</li>
      </ul>

      <h2 id="data">Data Model (optimat schema)</h2>
      <p>
        Most app state lives in the <code>optimat</code> schema. At a minimum, the current code expects:
      </p>
      <ul>
        <li><strong>providers</strong>: normalized provider records (used by map + provider portal + search/tools).</li>
        <li><strong>conversations</strong> and <strong>messages</strong>: chat sessions and message history.</li>
        <li>
          <strong>tool call tables</strong>: <code>find_providers_calls</code>, <code>search_addresses_calls</code>,
          <code>general_question_calls</code>. <code>get_provider_info_calls</code> still holds historical rows and is
          read by the replay and transcript endpoints, but nothing writes to it since that tool was removed.
        </li>
      </ul>

      <h2 id="deployment">Build &amp; Deployment</h2>
      <ul>
        <li><strong>Frontend</strong>: built by Vite (SvelteKit) and served as a static SPA (SSR disabled).</li>
        <li><strong>Backend</strong>: Supabase Edge Functions (Deno) deployed from <code>supabase/functions/*</code>.</li>
        <li>
          <strong>Configuration</strong>: frontend uses <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>;
          Edge Functions require server-side secrets (AWS + Google APIs).
        </li>
      </ul>

      <h2 id="security">Security Notes</h2>
      <p>
        The frontend uses the Supabase anon key for function calls. That’s normal, but it means access control must be enforced
        on the Edge Function side and/or via Postgres RLS policies.
      </p>
      <ul>
        <li>
          Ensure tables that contain user chat history have appropriate RLS policies and are not globally readable by anon.
        </li>
        <li>
          Consider requiring JWT verification for sensitive Edge Functions (or implement your own auth checks).
        </li>
        <li>
          Treat all tool call data persisted to Postgres as potentially sensitive (it can include addresses and trip details).
        </li>
      </ul>
    </article>
  </div>
</PageShell>
