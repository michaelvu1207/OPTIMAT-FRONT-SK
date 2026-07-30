<script lang="ts">
  import PageShell from '$lib/components/PageShell.svelte';

  const API_BASE_URL = 'https://api.optimat.us';
  const OPENAPI_URL = `${API_BASE_URL}/openapi.json`;
  const toc = [
    { id: 'quickstart', label: 'Quick start' },
    { id: 'access', label: 'Access and limits' },
    { id: 'providers', label: 'Providers' },
    { id: 'location', label: 'Location' },
    { id: 'chat', label: 'Chat' },
    { id: 'examples', label: 'Examples and replay' },
    { id: 'trip-data', label: 'Trip data' },
    { id: 'feedback', label: 'Feedback' },
    { id: 'admin', label: 'Administrative operations' },
  ];

  const providerExample = `curl '${API_BASE_URL}/providers/search?q=transit'`;
  const filterExample = `curl -X POST '${API_BASE_URL}/providers/filter' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "source_address": "Walnut Creek BART, Walnut Creek, CA",
    "destination_address": "Broadway Plaza, Walnut Creek, CA"
  }'`;
  const conversationExample = `curl -X POST '${API_BASE_URL}/conversations' \\
  -H 'Content-Type: application/json' \\
  -d '{"title":"Public API example"}'`;
  const chatExample = `curl -X POST '${API_BASE_URL}/chat' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "conversation_id": "<conversation-uuid>",
    "message": "Which transportation providers serve Walnut Creek?"
  }'`;
</script>

<PageShell
  title="Public API Docs"
  description="Anonymous JSON endpoints for OPTIMAT transportation data and rider tools"
  fullWidth={true}
>
  <div class="mx-auto max-w-5xl">
    <div class="mb-6 rounded-lg border border-border/60 bg-card p-4">
      <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div class="text-sm font-semibold">OPTIMAT Public API</div>
          <div class="text-xs text-muted-foreground">
            Production base URL: <code>{API_BASE_URL}</code>
          </div>
        </div>
        <nav class="flex flex-wrap gap-2" aria-label="API documentation sections">
          {#each toc as item}
            <a
              class="inline-flex items-center rounded-md border border-border/60 bg-background px-2 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
              href={`#${item.id}`}
            >
              {item.label}
            </a>
          {/each}
        </nav>
      </div>
    </div>

    <article class="prose prose-sm dark:prose-invert max-w-none">
      <h2 id="quickstart">Quick start</h2>
      <p>
        The production API is public and does not require an API key for the operations documented
        here. It returns JSON over HTTPS. Start with the health check or provider search:
      </p>
      <pre><code>curl '{API_BASE_URL}/health'</code></pre>
      <pre><code>{providerExample}</code></pre>
      <p>
        Machine-readable documentation is available as
        <a href={OPENAPI_URL} target="_blank" rel="noreferrer">OpenAPI 3.1 JSON</a>.
      </p>

      <h2 id="access">Access and limits</h2>
      <ul>
        <li><strong>Authentication:</strong> no key or bearer token is required for public operations.</li>
        <li><strong>CORS:</strong> <code>Access-Control-Allow-Origin: *</code>; public browser clients may call the API directly.</li>
        <li><strong>Rate limit:</strong> 25 requests per second sustained, with a burst of 50 across the API.</li>
        <li><strong>Content type:</strong> send <code>Content-Type: application/json</code> for JSON bodies.</li>
        <li><strong>Errors:</strong> JSON responses include an <code>error</code> string and HTTP status.</li>
      </ul>
      <p>
        Conversation UUIDs act like bearer identifiers: anyone who receives one can read that
        conversation. Do not publish them or send secrets, protected health information, or payment
        data to the public API.
      </p>

      <h2 id="providers">Providers</h2>
      <ul>
        <li><code>GET /providers</code> — list providers.</li>
        <li><code>GET /providers/search?q=transit</code> — search by provider name.</li>
        <li><code>GET /providers/map</code> — map-ready provider features.</li>
        <li><code>POST /providers/filter</code> — find providers for an origin and destination.</li>
        <li><code>GET /providers/:providerId</code> — retrieve one provider.</li>
        <li><code>GET /providers/:providerId/service-zone</code> — retrieve service-zone GeoJSON.</li>
      </ul>
      <pre><code>{filterExample}</code></pre>
      <p>Public provider responses intentionally omit private contact fields.</p>

      <h2 id="location">Location and routing</h2>
      <ul>
        <li><code>GET /geocode?address=...</code> — geocode with Amazon Location Service.</li>
        <li><code>POST /directions</code> — calculate driving or transit directions.</li>
      </ul>
      <pre><code>{`curl -X POST '${API_BASE_URL}/directions' \\
  -H 'Content-Type: application/json' \\
  -d '{"origin":"Walnut Creek BART","destination":"Broadway Plaza","mode":"driving"}'`}</code></pre>

      <h2 id="chat">Chat and conversations</h2>
      <p>Create a conversation first, then pass its UUID to the chat endpoint.</p>
      <pre><code>{conversationExample}</code></pre>
      <pre><code>{chatExample}</code></pre>
      <ul>
        <li><code>POST /conversations</code> — create an anonymous conversation.</li>
        <li><code>GET /conversations/:conversationId</code> — retrieve a conversation and its messages.</li>
        <li><code>GET /messages?conversation_id=...</code> — list messages.</li>
        <li><code>POST /messages</code> — append a message.</li>
        <li><code>POST /chat</code> — run the Bedrock-powered rider assistant.</li>
        <li><code>GET /tool-calls?conversation_id=...</code> — retrieve structured tool results.</li>
      </ul>

      <h2 id="examples">Examples and replay</h2>
      <ul>
        <li><code>GET /chat-examples</code> — list approved examples.</li>
        <li><code>GET /chat-examples/:id</code> — retrieve example metadata.</li>
        <li><code>GET /chat-examples/:id/with-states</code> — retrieve replay states.</li>
        <li><code>GET /replay?conversation_id=...</code> — build replay state for a conversation.</li>
      </ul>

      <h2 id="trip-data">Trip data</h2>
      <ul>
        <li><code>GET /trip-records/pairs</code></li>
        <li><code>GET /trip-records/pairs-grouped</code></li>
        <li><code>GET /trip-records/stats</code></li>
        <li><code>GET /trip-records/manifest/pairs</code></li>
        <li><code>GET /trip-records/manifest/pair-summaries</code></li>
        <li><code>GET /tri-delta-transit/trips</code></li>
        <li><code>GET /tri-delta-transit/routes?mode=driving</code></li>
      </ul>

      <h2 id="feedback">Feedback</h2>
      <p><code>POST /feedback</code> accepts a required <code>comment</code>, optional <code>rating</code>, and optional conversation UUID.</p>
      <pre><code>{`curl -X POST '${API_BASE_URL}/feedback' \\
  -H 'Content-Type: application/json' \\
  -d '{"comment":"Public API feedback","rating":"up"}'`}</code></pre>

      <h2 id="admin">Administrative operations</h2>
      <p>
        Provider updates, conversation deletion/listing, example mutation, replay publication, and
        trip-data uploads are not public operations. They require a server-held administrative
        credential and are intentionally omitted from the public OpenAPI document. Never embed that
        credential in browser code.
      </p>
    </article>
  </div>
</PageShell>
