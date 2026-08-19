/**
 * The chat assistant's memory between turns.
 *
 * Conversation history is rebuilt from optimat.messages, which stores role and text only.
 * Tool results therefore used to die with the turn: the assistant could not see the resolved
 * travel date, which providers matched, or why any were excluded, so any follow-up question
 * forced a fresh search — or an invented answer.
 *
 * This module folds each turn's tool results into a compact digest, persists it, and renders
 * it back into the system context as a facts block. A digest rather than a transcript: a few
 * hundred tokens instead of kilobytes of provider payload, and a stable anchor the model can
 * quote from.
 */

import { TABLES } from "../_shared/supabase.ts";
import type { RiderEligibility } from "./trip.ts";

type DatabaseClient = any;

export interface TripFacts {
  origin?: string | null;
  destination?: string | null;
  coverage?: "covered" | "not_covered" | null;
  travel_date?: string | null;
  travel_date_display?: string | null;
  departure_time?: string | null;
  outbound_time_intent?: string | null;
  return_time?: string | null;
  trip_type?: string | null;
  rider?: RiderEligibility | null;
}

export interface ProviderNote {
  name: string;
  reason?: string | null;
  requirement?: string | null;
  missing?: string[];
  booking?: string | null;
  phone?: string | null;
  website?: string | null;
}

export interface SearchAlternative {
  change: string;
  description: string;
  providers: string[];
  count: number;
}

export interface NextQuestion {
  field: string;
  why: string;
  candidates_if_known: number;
}

export interface SearchDigest {
  searched_at?: string;
  travel_date_display?: string | null;
  departure_time?: string | null;
  trip_type?: string | null;
  eligible: ProviderNote[];
  /** Providers matching the trip whose eligibility could not be settled; `missing` names why. */
  verification: ProviderNote[];
  excluded: ProviderNote[];
  public_transit: { available: boolean; duration_text?: string | null } | null;
  binding_constraint: "geography" | "schedule" | "eligibility" | null;
  alternatives: SearchAlternative[];
  next_question: NextQuestion | null;
  diagnostics: Record<string, number> | null;
}

export interface TripState {
  trip: TripFacts;
  last_search: SearchDigest | null;
}

export interface ChatAttachment {
  type: string;
  data: unknown;
  metadata?: Record<string, unknown>;
}

export function emptyTripState(): TripState {
  return { trip: {}, last_search: null };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(asRecord(entry))) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function providerNote(entry: Record<string, unknown>): ProviderNote | null {
  const name = text(entry.provider_name) || text(entry.name);
  if (!name) return null;
  const note: ProviderNote = { name };
  const reason = text(entry.eligibility_reason) || text(entry.reason);
  if (reason) note.reason = reason;
  const requirement = text(entry.requirement) ?? (entry.eligibility_reqs ? String(entry.eligibility_reqs).slice(0, 180) : null);
  if (requirement) note.requirement = requirement;
  if (Array.isArray(entry.missing_facts) && entry.missing_facts.length > 0) {
    note.missing = entry.missing_facts.map(String);
  }
  const booking = text(entry.booking);
  if (booking) note.booking = booking.slice(0, 200);
  const website = text(entry.website);
  if (website) note.website = website;
  return note;
}

function providerNotes(value: unknown): ProviderNote[] {
  return asArray(value).map(providerNote).filter((note): note is ProviderNote => Boolean(note));
}

/**
 * Which stage actually stopped the search. Reported so the assistant can name one definite
 * reason instead of listing guesses.
 */
export function deriveBindingConstraint(
  diagnostics: Record<string, unknown> | null,
  eligibleCount: number,
): SearchDigest["binding_constraint"] {
  if (eligibleCount > 0) return null;
  if (!diagnostics) return null;
  if (Number(diagnostics.geography_match_count || 0) === 0) return "geography";
  if (Number(diagnostics.schedule_match_count || 0) === 0) return "schedule";
  return "eligibility";
}

function numericDiagnostics(value: unknown): Record<string, number> | null {
  const record = asRecord(value);
  if (!record) return null;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function sameLocationPair(trip: TripFacts, origin: string | null, destination: string | null): boolean {
  if (!origin || !destination) return true;
  if (!trip.origin || !trip.destination) return true;
  return trip.origin === origin && trip.destination === destination;
}

function riderFacts(value: unknown, previous: RiderEligibility | null | undefined): RiderEligibility | null {
  const record = asRecord(value);
  if (!record) return previous ?? null;
  const merged: RiderEligibility = { ...(previous || {}) };
  if (Number.isFinite(Number(record.age))) merged.age = Number(record.age);
  for (const key of ["disabled", "ada_certified", "veteran", "declined"] as const) {
    if (typeof record[key] === "boolean") merged[key] = record[key] as boolean;
  }
  const city = text(record.residence_city);
  if (city) merged.residence_city = city;
  return merged;
}

/**
 * Fold this turn's tool results into the state.
 *
 * A new origin/destination pair supersedes rather than merges: an unrelated second trip in the
 * same conversation must not inherit the first trip's date, times, or search result.
 */
export function updateTripStateFromTools(state: TripState, attachments: ChatAttachment[]): TripState {
  let next: TripState = { trip: { ...state.trip }, last_search: state.last_search };

  for (const attachment of attachments) {
    const toolName = typeof attachment.metadata?.tool_name === "string" ? attachment.metadata.tool_name : "";
    const data = asRecord(attachment.data);
    if (!data) continue;

    if (toolName === "check_trip_coverage") {
      const origin = text(data.source_address);
      const destination = text(data.destination_address);
      if (!sameLocationPair(next.trip, origin, destination)) {
        next = { trip: { rider: next.trip.rider ?? null }, last_search: null };
      }
      if (origin) next.trip.origin = origin;
      if (destination) next.trip.destination = destination;
      if (data.status === "covered" || data.status === "not_covered") {
        next.trip.coverage = data.status;
      }
      continue;
    }

    if (toolName === "resolve_trip_date") {
      if (data.status === "resolved") {
        next.trip.travel_date = text(data.travel_date);
        next.trip.travel_date_display = text(data.travel_date_display);
      }
      continue;
    }

    // find_providers now stops at candidates; the rider-facing verdicts arrive with
    // assess_eligibility, which returns the search result with the buckets filled in. Both are
    // folded in: a search that never reached assessment still updates the trip facts.
    if (toolName !== "find_providers" && toolName !== "assess_eligibility") continue;

    const origin = text(data.source_address);
    const destination = text(data.destination_address);
    if (!sameLocationPair(next.trip, origin, destination)) {
      next = { trip: { rider: next.trip.rider ?? null }, last_search: null };
    }
    if (origin) next.trip.origin = origin;
    if (destination) next.trip.destination = destination;
    next.trip.rider = riderFacts(data.rider_eligibility, next.trip.rider);

    if (data.status !== "complete") continue;

    if (text(data.travel_date)) next.trip.travel_date = text(data.travel_date);
    if (text(data.travel_date_display)) next.trip.travel_date_display = text(data.travel_date_display);
    if (text(data.departure_time)) next.trip.departure_time = text(data.departure_time);
    if (text(data.outbound_time_intent)) next.trip.outbound_time_intent = text(data.outbound_time_intent);
    next.trip.return_time = text(data.return_time);
    if (text(data.trip_type)) next.trip.trip_type = text(data.trip_type);
    next.trip.coverage = Number(numericDiagnostics(data.diagnostics)?.geography_match_count || 0) > 0
      ? "covered"
      : "not_covered";

    // A bare find_providers result carries candidates and no verdicts. Recording it as a search
    // with zero eligible providers would tell the assistant the trip failed, so the digest waits
    // for the assessment that follows.
    if (toolName === "find_providers" && !Array.isArray(data.data)) continue;

    const eligible = providerNotes(data.data);
    const transit = asRecord(data.public_transit);
    const alternatives = asArray(data.alternatives)
      .map((entry) => ({
        change: text(entry.change) || "alternative",
        description: text(entry.description) || "",
        providers: Array.isArray(entry.providers) ? entry.providers.map(String) : [],
        count: Number(entry.count || (Array.isArray(entry.providers) ? entry.providers.length : 0)),
      }))
      .filter((entry) => entry.count > 0 || entry.description);
    const nextQuestionRecord = asRecord(data.next_question);

    next.last_search = {
      searched_at: new Date().toISOString(),
      travel_date_display: next.trip.travel_date_display ?? null,
      departure_time: next.trip.departure_time ?? null,
      trip_type: next.trip.trip_type ?? null,
      eligible,
      verification: providerNotes(data.verification_required),
      excluded: providerNotes(data.excluded_providers),
      public_transit: transit
        ? { available: true, duration_text: text(transit.duration_text) }
        : { available: false },
      binding_constraint: deriveBindingConstraint(asRecord(data.diagnostics), eligible.length),
      alternatives,
      next_question: nextQuestionRecord && text(nextQuestionRecord.field)
        ? {
          field: String(nextQuestionRecord.field),
          why: text(nextQuestionRecord.why) || "",
          candidates_if_known: Number(nextQuestionRecord.candidates_if_known || 0),
        }
        : null,
      diagnostics: numericDiagnostics(data.diagnostics),
    };
  }

  return next;
}

function describeRider(rider: RiderEligibility | null | undefined): string {
  if (!rider) return "nothing stated yet";
  const parts: string[] = [];
  if (Number.isFinite(rider.age)) parts.push(`age ${rider.age}`);
  if (typeof rider.disabled === "boolean") parts.push(rider.disabled ? "disabled" : "not disabled");
  if (typeof rider.ada_certified === "boolean") {
    parts.push(rider.ada_certified ? "has ADA paratransit eligibility" : "does not have ADA paratransit eligibility");
  }
  if (typeof rider.veteran === "boolean") parts.push(rider.veteran ? "veteran" : "not a veteran");
  if (rider.residence_city) parts.push(`lives in ${rider.residence_city}`);
  if (rider.declined) parts.push("declined to answer further eligibility questions");
  return parts.length > 0 ? parts.join(", ") : "nothing stated yet";
}

const UNKNOWN_FIELD_LABELS: Record<string, string> = {
  age: "exact age",
  disabled: "whether the rider has a disability",
  ada_certified: "ADA paratransit eligibility",
  veteran: "veteran status",
  residence_city: "city of residence",
};

function unknownTripFields(trip: TripFacts): string[] {
  const unknown: string[] = [];
  if (!trip.origin) unknown.push("pickup location");
  if (!trip.destination) unknown.push("destination");
  if (!trip.travel_date) unknown.push("travel date");
  if (!trip.departure_time) unknown.push("outbound time");
  if (!trip.trip_type) unknown.push("one-way or round trip");
  if (trip.trip_type === "round_trip" && !trip.return_time) unknown.push("return time");
  return unknown;
}

function providerLine(note: ProviderNote): string {
  const detail = note.reason ? ` — ${note.reason}` : note.requirement ? ` — requires: ${note.requirement}` : "";
  return `  - ${note.name}${detail}`;
}

/**
 * Render the state as a fact sheet for the system context. Everything here is server-verified;
 * the assistant states it in its own words rather than repeating it verbatim.
 */
export function buildFactsBlock(state: TripState): string {
  const { trip, last_search: search } = state;
  const lines: string[] = [];

  const known: string[] = [];
  if (trip.origin) known.push(`pickup ${trip.origin}`);
  if (trip.destination) known.push(`destination ${trip.destination}`);
  if (trip.travel_date_display) known.push(`travel date ${trip.travel_date_display}`);
  if (trip.departure_time) {
    known.push(
      `outbound ${trip.departure_time}${trip.outbound_time_intent === "arrive_by" ? " (arrive by)" : " (depart at)"}`,
    );
  }
  if (trip.trip_type) known.push(trip.trip_type === "round_trip" ? "round trip" : "one way");
  if (trip.return_time) known.push(`return ${trip.return_time}`);

  if (known.length === 0 && !search) return "";

  lines.push("Known trip facts (server-verified — do not re-ask for these):");
  if (known.length > 0) {
    for (const fact of known) lines.push(`- ${fact}`);
  } else {
    lines.push("- nothing confirmed yet");
  }
  lines.push(`- rider: ${describeRider(trip.rider)}`);
  if (trip.coverage) {
    lines.push(
      trip.coverage === "covered"
        ? "- at least one provider service area covers both ends of this trip"
        : "- no provider service area covers both ends of this trip",
    );
  }

  const unknown = unknownTripFields(trip);
  if (unknown.length > 0) lines.push(`- still unknown: ${unknown.join(", ")}`);

  if (search) {
    lines.push("", `Most recent provider search (${search.travel_date_display || "date unknown"}, outbound ${search.departure_time || "unknown"}):`);
    lines.push(`- ${search.eligible.length} provider(s) the rider qualifies for`);
    for (const note of search.eligible) lines.push(providerLine(note));
    if (search.verification.length > 0) {
      lines.push(`- ${search.verification.length} provider(s) match the trip but eligibility is unconfirmed:`);
      for (const note of search.verification) {
        const missing = (note.missing || []).map((field) => UNKNOWN_FIELD_LABELS[field] || field).join(", ");
        lines.push(missing ? `  - ${note.name} — decided by ${missing}` : providerLine(note));
      }
    }
    if (search.excluded.length > 0) {
      lines.push(`- ${search.excluded.length} provider(s) ruled out:`);
      for (const note of search.excluded) lines.push(providerLine(note));
    }
    if (search.public_transit?.available) {
      lines.push(
        `- public transit is available for this trip${search.public_transit.duration_text ? ` (about ${search.public_transit.duration_text})` : ""}`,
      );
    }
    // Operating hours are missing for most provider rows, so the schedule filter passed them
    // through without checking anything. Saying the requested time works would be a guess.
    const withoutHours = Number(search.diagnostics?.providers_without_service_hours || 0);
    if (withoutHours > 0) {
      lines.push(
        `- ${withoutHours} of these provider(s) have no operating hours on file, so the requested time was NOT verified —` +
          ` tell the rider to confirm the time when they call, and do not state that the time is available`,
      );
    }
    if (search.binding_constraint) {
      const explanation = {
        geography: "no provider service area covers both ends — changing the date or time cannot fix this",
        schedule: "service areas cover the trip but none operate at the requested date and time",
        eligibility: "providers cover the trip and time, but the rider does not match their eligibility rules",
      }[search.binding_constraint];
      lines.push(`- binding constraint: ${explanation}`);
    }
    if (search.alternatives.length > 0) {
      lines.push("- alternatives that would work (state these as possibilities, never as bookings):");
      for (const alternative of search.alternatives) {
        lines.push(`  - ${alternative.description}${alternative.providers.length > 0 ? ` (${alternative.providers.join(", ")})` : ""}`);
      }
    }
    if (search.next_question) {
      lines.push(
        `- most useful thing to ask next: ${UNKNOWN_FIELD_LABELS[search.next_question.field] || search.next_question.field}` +
          ` — ${search.next_question.why}`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * Drop digests older than 30 days so stale rider eligibility answers cannot linger.
 *
 * pg_cron is not installed on this project, so the scheduled job in the migration was skipped and
 * this is the only thing enforcing retention. Deliberately not awaited: it must never add latency
 * to a rider's turn, and a missed run is corrected by the next new conversation.
 */
function purgeStaleStateInBackground(supabase: DatabaseClient): void {
  try {
    const result = supabase.rpc("purge_stale_chat_trip_state");
    Promise.resolve(result)
      .then(({ error }: { error: unknown }) => {
        if (error) console.warn("Chat trip state purge failed:", error);
      })
      .catch((error: unknown) => console.warn("Chat trip state purge failed:", error));
  } catch (error) {
    console.warn("Chat trip state purge could not start:", error);
  }
}

export async function loadTripState(supabase: DatabaseClient, conversationId: string): Promise<TripState> {
  try {
    const { data, error } = await supabase
      .from(TABLES.CHAT_TRIP_STATE)
      .select("trip, last_search")
      .eq("conversation_id", conversationId)
      .maybeSingle();

    if (error || !data) {
      // First turn of this conversation: a cheap, infrequent moment to run retention.
      purgeStaleStateInBackground(supabase);
      return emptyTripState();
    }
    return {
      trip: asRecord(data.trip) as TripFacts || {},
      last_search: asRecord(data.last_search) as SearchDigest | null,
    };
  } catch (error) {
    console.warn("Could not load chat trip state:", error);
    return emptyTripState();
  }
}

export async function saveTripState(
  supabase: DatabaseClient,
  conversationId: string,
  state: TripState,
): Promise<void> {
  if (Object.keys(state.trip).length === 0 && !state.last_search) return;
  try {
    const { error } = await supabase.from(TABLES.CHAT_TRIP_STATE).upsert(
      {
        conversation_id: conversationId,
        trip: state.trip,
        last_search: state.last_search,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "conversation_id" },
    );
    if (error) console.error("Error saving chat trip state:", error);
  } catch (error) {
    console.error("Error saving chat trip state:", error);
  }
}
