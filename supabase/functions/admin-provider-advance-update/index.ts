import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type UpdatePayload = {
  updates?: Array<{
    provider_id: number;
    schedule_type: Record<string, unknown>;
  }>;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const expectedToken = Deno.env.get("PROVIDER_ADVANCE_UPDATE_TOKEN") || "";
  const actualToken = req.headers.get("x-admin-token") || "";
  if (!expectedToken || actualToken !== expectedToken) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Missing Supabase admin configuration" }, 500);
  }

  const body = (await req.json()) as UpdatePayload;
  const updates = Array.isArray(body.updates) ? body.updates : [];
  if (updates.length === 0) {
    return jsonResponse({ error: "updates array is required" }, 400);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    db: {
      schema: "optimat",
    },
  });

  const updated = [];
  for (const item of updates) {
    if (!Number.isFinite(item.provider_id) || typeof item.schedule_type !== "object") {
      return jsonResponse({ error: "Invalid update payload", item }, 400);
    }

    const { data, error } = await supabase
      .from("providers")
      .update({
        schedule_type: item.schedule_type,
        updated_at: new Date().toISOString(),
      })
      .eq("provider_id", item.provider_id)
      .select("provider_id, provider_name, schedule_type")
      .single();

    if (error) {
      return jsonResponse({ error: error.message, provider_id: item.provider_id }, 500);
    }

    updated.push(data);
  }

  return jsonResponse({
    success: true,
    updated_count: updated.length,
    updated,
  });
});
