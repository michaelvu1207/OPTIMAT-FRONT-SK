import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

serve(() =>
  new Response(JSON.stringify({ error: "Provider import endpoint is disabled" }), {
    status: 410,
    headers: { "Content-Type": "application/json" },
  })
);
