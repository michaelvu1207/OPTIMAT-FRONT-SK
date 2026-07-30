<script lang="ts">
  import PageShell from '$lib/components/PageShell.svelte';

  const API_BASE_URL = 'https://api.optimat.us';
  const toc = [
    { id: 'overview', label: 'Overview' },
    { id: 'frontend', label: 'Frontend' },
    { id: 'api', label: 'Public API' },
    { id: 'compute', label: 'Compute and AI' },
    { id: 'data', label: 'Data and retention' },
    { id: 'security', label: 'Security' },
    { id: 'deployment', label: 'Deployment' },
  ];
</script>

<PageShell
  title="Architecture Docs"
  description="How the OPTIMAT frontend and public AWS backend fit together"
  fullWidth={true}
>
  <div class="mx-auto max-w-5xl">
    <div class="mb-6 rounded-lg border border-border/60 bg-card p-4">
      <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div class="text-sm font-semibold">Production architecture</div>
          <div class="text-xs text-muted-foreground">AWS region: <code>us-west-1</code></div>
        </div>
        <nav class="flex flex-wrap gap-2" aria-label="Architecture documentation sections">
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
      <h2 id="overview">Overview</h2>
      <p>
        OPTIMAT is a static SvelteKit single-page application backed by a public HTTPS API on AWS.
        API Gateway routes requests to small Node.js Lambda functions. Aurora PostgreSQL stores
        provider, conversation, message, tool-call, and trip data. AWS-native services provide AI,
        location, routing, transcription, secrets, logs, and archival storage.
      </p>

      <div class="not-prose my-4 overflow-x-auto rounded-lg border border-border/60 bg-background p-4">
        <svg viewBox="0 0 980 360" class="min-w-[760px] w-full h-auto" role="img" aria-label="OPTIMAT AWS architecture diagram">
          <defs>
            <marker id="aws-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
              <path d="M0,0 L10,3 L0,6 Z" fill="var(--muted-foreground)"></path>
            </marker>
          </defs>

          <rect x="25" y="95" width="190" height="110" rx="12" fill="var(--card)" stroke="var(--border)" />
          <text x="48" y="125" fill="var(--foreground)" font-size="14" font-weight="600">Browser</text>
          <text x="48" y="150" fill="var(--muted-foreground)" font-size="12">SvelteKit SPA</text>
          <text x="48" y="172" fill="var(--muted-foreground)" font-size="12">AWS Amplify hosting</text>

          <rect x="275" y="80" width="190" height="140" rx="12" fill="var(--card)" stroke="var(--border)" />
          <text x="298" y="112" fill="var(--foreground)" font-size="14" font-weight="600">Public API</text>
          <text x="298" y="137" fill="var(--muted-foreground)" font-size="12">api.optimat.us</text>
          <text x="298" y="159" fill="var(--muted-foreground)" font-size="12">API Gateway HTTP API</text>
          <text x="298" y="181" fill="var(--muted-foreground)" font-size="12">CORS + throttling + logs</text>

          <rect x="530" y="30" width="195" height="115" rx="12" fill="var(--card)" stroke="var(--border)" />
          <text x="553" y="60" fill="var(--foreground)" font-size="14" font-weight="600">Application</text>
          <text x="553" y="85" fill="var(--muted-foreground)" font-size="12">Node.js 24 Lambdas</text>
          <text x="553" y="107" fill="var(--muted-foreground)" font-size="12">Amazon Bedrock + Location</text>
          <text x="553" y="129" fill="var(--muted-foreground)" font-size="12">Amazon Transcribe</text>

          <rect x="530" y="190" width="195" height="115" rx="12" fill="var(--card)" stroke="var(--border)" />
          <text x="553" y="220" fill="var(--foreground)" font-size="14" font-weight="600">Data</text>
          <text x="553" y="245" fill="var(--muted-foreground)" font-size="12">Aurora PostgreSQL 17.7</text>
          <text x="553" y="267" fill="var(--muted-foreground)" font-size="12">Serverless v2, encrypted</text>
          <text x="553" y="289" fill="var(--muted-foreground)" font-size="12">Private subnets</text>

          <rect x="790" y="110" width="165" height="130" rx="12" fill="var(--card)" stroke="var(--border)" />
          <text x="813" y="140" fill="var(--foreground)" font-size="14" font-weight="600">Operations</text>
          <text x="813" y="165" fill="var(--muted-foreground)" font-size="12">CloudWatch</text>
          <text x="813" y="187" fill="var(--muted-foreground)" font-size="12">Secrets Manager</text>
          <text x="813" y="209" fill="var(--muted-foreground)" font-size="12">S3 + Glacier archive</text>

          <line x1="215" y1="150" x2="275" y2="150" stroke="var(--muted-foreground)" stroke-width="2" marker-end="url(#aws-arrow)" />
          <line x1="465" y1="125" x2="530" y2="95" stroke="var(--muted-foreground)" stroke-width="2" marker-end="url(#aws-arrow)" />
          <line x1="627" y1="145" x2="627" y2="190" stroke="var(--muted-foreground)" stroke-width="2" marker-end="url(#aws-arrow)" />
          <line x1="725" y1="105" x2="790" y2="150" stroke="var(--muted-foreground)" stroke-width="2" marker-end="url(#aws-arrow)" />
          <line x1="725" y1="245" x2="790" y2="205" stroke="var(--muted-foreground)" stroke-width="2" marker-end="url(#aws-arrow)" />
        </svg>
      </div>

      <h2 id="frontend">Frontend</h2>
      <ul>
        <li><strong>Framework:</strong> SvelteKit and Vite, rendered as a static SPA.</li>
        <li><strong>Hosting:</strong> AWS Amplify serves <code>optimat.us</code>.</li>
        <li><strong>API selection:</strong> production uses <code>VITE_API_BACKEND=aws</code> and <code>VITE_AWS_API_URL=https://api.optimat.us</code>.</li>
        <li><strong>Maps:</strong> Leaflet renders provider zones, results, and routes in the browser.</li>
      </ul>

      <h2 id="api">Public API</h2>
      <p>
        API Gateway exposes <code>{API_BASE_URL}</code>. Public operations require no API key and
        return JSON. CORS permits public browser clients. The stage is throttled to 25 requests per
        second with a burst of 50 and writes structured access logs to CloudWatch.
      </p>
      <ul>
        <li>Provider reads, search, filters, map data, and service zones</li>
        <li>Amazon Location geocoding and routing</li>
        <li>Anonymous rider conversations, messages, Bedrock chat, and feedback</li>
        <li>Approved examples/replay and historical trip-data reads</li>
      </ul>
      <p>
        The public contract is published at <a href={`${API_BASE_URL}/openapi.json`} target="_blank" rel="noreferrer"><code>/openapi.json</code></a>.
        Administrative mutations remain protected inside their Lambda handlers and are not listed
        as public OpenAPI operations.
      </p>

      <h2 id="compute">Compute and AI</h2>
      <p>
        Each API area is an ARM64 Node.js 24 Lambda function. Chat uses an application IAM role to
        call Amazon Bedrock; no long-lived AWS key is stored in the browser. Provider search tools
        query Aurora and call Amazon Location for places and routes. Voice input uses Amazon
        Transcribe with transient encrypted S3 input objects.
      </p>

      <h2 id="data">Data and retention</h2>
      <ul>
        <li><strong>Online data:</strong> Aurora PostgreSQL 17.7 Serverless v2 in private subnets.</li>
        <li><strong>Protection:</strong> encryption, deletion protection, automated backups, and retained CloudFormation resources.</li>
        <li><strong>Archive:</strong> versioned S3 with no expiration; Standard-IA, Glacier, and Deep Archive transitions reduce long-term cost.</li>
        <li><strong>Organization access:</strong> archive read/list access is limited to principals in the AWS organization.</li>
      </ul>

      <h2 id="security">Security boundaries</h2>
      <ul>
        <li>Public provider DTOs omit private contacts and internal-only fields.</li>
        <li>Administrative updates require a server-held token and are never part of the anonymous contract.</li>
        <li>Secrets remain in Secrets Manager and workloads receive permissions through IAM roles.</li>
        <li>Conversation UUIDs are bearer-like identifiers; clients must not expose them.</li>
        <li>Public API requests are rate-limited and application/API logs are retained in CloudWatch.</li>
      </ul>

      <h2 id="deployment">Build and deployment</h2>
      <ul>
        <li><strong>Infrastructure:</strong> SAM/CloudFormation templates in <code>infra/</code>.</li>
        <li><strong>Application stack:</strong> API Gateway, Lambda functions, custom domain, logs, and supporting S3 resources.</li>
        <li><strong>Database stack:</strong> VPC, private networking, Aurora, encryption, and security groups.</li>
        <li><strong>Frontend:</strong> merges to <code>master</code> trigger the Amplify production build.</li>
      </ul>
    </article>
  </div>
</PageShell>
