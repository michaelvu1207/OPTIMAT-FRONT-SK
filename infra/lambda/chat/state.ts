import { query, queryOne, TABLES } from '../_shared/db.js';
import type { RiderEligibility, TurnContext } from './tools.js';

type StoredTripState = {
  rider_eligibility?: RiderEligibility;
  [key: string]: unknown;
};

export async function loadTurnContext(conversationId: string): Promise<TurnContext> {
  try {
    const row = await queryOne<{ trip?: StoredTripState | string | null }>(
      `SELECT trip FROM ${TABLES.CHAT_TRIP_STATE} WHERE conversation_id = $1`,
      [conversationId],
    );
    let trip = row?.trip || {};
    if (typeof trip === 'string') {
      try { trip = JSON.parse(trip); } catch { trip = {}; }
    }
    return {
      riderEligibility: (trip as StoredTripState).rider_eligibility || {},
      lastSearch: null,
      latestAssessment: null,
    };
  } catch (error) {
    // State improves continuity but must not make the chat endpoint unavailable during a rollout
    // where the additive table has not landed yet.
    console.warn('Unable to load chat trip state', error);
    return { riderEligibility: {}, lastSearch: null, latestAssessment: null };
  }
}

export function buildRiderFactsBlock(rider: RiderEligibility): string {
  const facts: string[] = [];
  if (Number.isFinite(rider.age)) facts.push(`age=${rider.age}`);
  if (typeof rider.disabled === 'boolean') facts.push(`disabled=${rider.disabled}`);
  if (typeof rider.ada_paratransit_eligible === 'boolean') {
    facts.push(`ada_paratransit_eligible=${rider.ada_paratransit_eligible}`);
  }
  if (typeof rider.veteran === 'boolean') facts.push(`veteran=${rider.veteran}`);
  if (rider.residence_city?.trim()) facts.push(`residence_city=${rider.residence_city.trim()}`);
  if (rider.declined) facts.push('declined_further_eligibility_questions=true');
  return facts.length > 0
    ? `Known rider facts from prior turns: ${facts.join(', ')}. Reuse them unless the rider corrects them.`
    : 'No rider eligibility facts are stored yet. Do not infer residence from a pickup address.';
}

export function buildCurrentTimeBlock(now = new Date()): string {
  const timeZone = 'America/Los_Angeles';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || '';
  const localDate = `${value('year')}-${value('month')}-${value('day')}`;
  const localTime = `${value('hour')}:${value('minute')} ${value('dayPeriod')} ${value('timeZoneName')}`;

  return [
    `Current local date and time: ${localDate} ${localTime} (${timeZone}).`,
    'Resolve relative dates such as today, tomorrow, and next Monday from this date. Never use a model training date or an example date.',
  ].join('\n');
}

export async function saveTurnContext(conversationId: string, turn: TurnContext): Promise<void> {
  try {
    await query(
      `INSERT INTO ${TABLES.CHAT_TRIP_STATE} AS stored_state (conversation_id, trip, last_search, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, NOW())
       ON CONFLICT (conversation_id) DO UPDATE SET
         trip = EXCLUDED.trip,
         last_search = COALESCE(EXCLUDED.last_search, stored_state.last_search),
         updated_at = NOW()`,
      [
        conversationId,
        JSON.stringify({ rider_eligibility: turn.riderEligibility }),
        turn.latestAssessment ? JSON.stringify(turn.latestAssessment) : null,
      ],
    );
  } catch (error) {
    console.warn('Unable to save chat trip state', error);
  }
}
