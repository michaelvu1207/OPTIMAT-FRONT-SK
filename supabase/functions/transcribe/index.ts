/**
 * Audio transcription Edge Function.
 *
 * Accepts multipart/form-data with a `file` audio part and returns text from
 * OpenAI's transcription API. The OpenAI API key must stay server-side.
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import {
  errorResponse,
  handleCorsPreflightRequest,
  jsonResponse,
} from "../_shared/cors.ts";

const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_MODEL = "gpt-4o-mini-transcribe";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function getFileExtension(file: File): string {
  if (file.name.includes(".")) {
    return file.name.split(".").pop() || "webm";
  }
  if (file.type.includes("mp4")) return "mp4";
  if (file.type.includes("ogg")) return "ogg";
  if (file.type.includes("mpeg")) return "mp3";
  return "webm";
}

serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(origin);
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405, origin);
  }

  const openAiApiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openAiApiKey) {
    return errorResponse("OpenAI transcription is not configured.", 500, origin);
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return errorResponse("Expected multipart form data.", 400, origin);
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return errorResponse("Missing audio file.", 400, origin);
  }

  if (file.size <= 0) {
    return errorResponse("Audio file was empty.", 400, origin);
  }

  if (file.size > MAX_AUDIO_BYTES) {
    return errorResponse("Audio file is too large. Please record a shorter message.", 413, origin);
  }

  const model = Deno.env.get("OPENAI_TRANSCRIBE_MODEL") || DEFAULT_MODEL;
  const outbound = new FormData();
  const extension = getFileExtension(file);
  outbound.append("file", file, file.name || `voice-input.${extension}`);
  outbound.append("model", model);

  const language = formData.get("language");
  if (typeof language === "string" && language.trim()) {
    outbound.append("language", language.trim());
  }

  const prompt = formData.get("prompt");
  if (typeof prompt === "string" && prompt.trim()) {
    outbound.append("prompt", prompt.trim());
  }

  let openAiResponse: Response;
  try {
    openAiResponse = await fetch(OPENAI_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: outbound,
    });
  } catch (err) {
    console.error("OpenAI transcription request failed:", err);
    return errorResponse("Unable to reach transcription service.", 502, origin);
  }

  const raw = await openAiResponse.text();
  let parsed: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = { text: raw };
    }
  }

  if (!openAiResponse.ok) {
    console.error("OpenAI transcription failed:", openAiResponse.status, parsed);
    const message =
      typeof parsed.error === "object" && parsed.error !== null && "message" in parsed.error
        ? String((parsed.error as { message?: unknown }).message)
        : "Transcription failed.";
    return errorResponse(message, openAiResponse.status, origin);
  }

  return jsonResponse(
    {
      text: typeof parsed.text === "string" ? parsed.text : "",
      model,
    },
    200,
    origin
  );
});
