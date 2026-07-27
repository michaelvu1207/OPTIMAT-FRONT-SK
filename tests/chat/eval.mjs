#!/usr/bin/env node
/**
 * Chat agent evaluation harness.
 *
 * Scores the deployed assistant on properties rather than exact wording, so the same
 * assertions keep working while the model's phrasing changes. Every scenario in
 * scenarios.json is replayed as a real conversation against a live deployment.
 *
 * Usage:
 *   node tests/chat/eval.mjs                                   # uses .env (production)
 *   node tests/chat/eval.mjs <functions-base-url> <anon-key>
 *   node tests/chat/eval.mjs --only s04,s09                    # subset by id prefix
 *   node tests/chat/eval.mjs --out tests/chat/baseline-2026-07-27.json
 *   node tests/chat/eval.mjs --concurrency 3
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

// ─── Configuration ──────────────────────────────────────────────────────────

function readEnvFile() {
  const path = resolve(ROOT, '.env');
  if (!existsSync(path)) return {};
  const vars = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return vars;
}

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const idx = argv.indexOf(`--${name}`);
  return idx === -1 ? fallback : argv[idx + 1];
}
const positional = argv.filter((arg, i) => !arg.startsWith('--') && !String(argv[i - 1] || '').startsWith('--'));

const env = readEnvFile();
const BASE_URL = (positional[0] || `${env.VITE_SUPABASE_URL || 'https://htjohidcoyfuwfjecazu.supabase.co'}/functions/v1`).replace(/\/$/, '');
const ANON_KEY = positional[1] || env.VITE_SUPABASE_ANON_KEY || '';
const ONLY = (flag('only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = flag('out');
const CONCURRENCY = Number(flag('concurrency', '3'));
const TURN_TIMEOUT_MS = Number(flag('timeout', '180000'));

if (!ANON_KEY) {
  console.error('Missing anon key. Pass it as the second argument or set VITE_SUPABASE_ANON_KEY in .env');
  process.exit(2);
}

const headers = {
  'Content-Type': 'application/json',
  apikey: ANON_KEY,
  Authorization: `Bearer ${ANON_KEY}`,
};

// ─── Transport ──────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bedrock throttles the Opus 5 inference profile under concurrent load and the edge function
 * surfaces it as a 500 ("Bedrock is unable to process your request"). That is a capacity limit,
 * not assistant behaviour, so it is retried with backoff rather than scored as a failure.
 */
const RETRYABLE = /Bedrock is unable to process|ThrottlingException|Too many requests|ServiceUnavailable|502|503|504/i;

async function postOnce(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
    if (!response.ok) {
      const error = new Error(`POST ${path} → ${response.status}: ${text.slice(0, 400)}`);
      error.retryable = RETRYABLE.test(text) || response.status >= 502;
      throw error;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function post(path, body, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await postOnce(path, body);
    } catch (error) {
      lastError = error;
      if (!error.retryable || attempt === attempts) break;
      const backoff = 4000 * attempt + Math.floor(Math.random() * 2000);
      console.warn(`  retrying after capacity error (attempt ${attempt}/${attempts}, waiting ${(backoff / 1000).toFixed(1)}s)`);
      await sleep(backoff);
    }
  }
  throw lastError;
}

async function getJson(path) {
  const response = await fetch(`${BASE_URL}${path}`, { headers });
  if (!response.ok) throw new Error(`GET ${path} → ${response.status}`);
  return response.json();
}

async function loadProviderNames() {
  try {
    const payload = await getJson('/providers?limit=500');
    const rows = Array.isArray(payload) ? payload : payload.data || [];
    return rows.map((row) => String(row.provider_name || '').trim()).filter(Boolean);
  } catch (error) {
    console.warn(`Could not load provider names for grounding (${error.message}); skipping that assertion.`);
    return null;
  }
}

// ─── Text analysis helpers ──────────────────────────────────────────────────

const NUMBER_WORDS = {
  no: 0, zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** Every provider count the message claims, e.g. "3 providers", "one provider", "no providers". */
export function providerCounts(text) {
  const counts = [];
  const pattern = /\b(\d{1,3}|no|zero|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:more\s+|additional\s+|other\s+|direct\s+|transportation\s+)*provider/gi;
  for (const match of text.matchAll(pattern)) {
    const token = match[1].toLowerCase();
    const value = token in NUMBER_WORDS ? NUMBER_WORDS[token] : Number(token);
    if (Number.isFinite(value)) counts.push({ value, phrase: match[0].trim() });
  }
  return counts;
}

/**
 * A message may legitimately state several different counts when it qualifies them
 * ("2 providers can take you, 1 more provider needs verification"). Only an unqualified
 * repetition of a different total is a contradiction, so qualified phrases are excluded.
 */
function contradictoryCounts(text) {
  const unqualified = providerCounts(text).filter(
    (count) => !/\b(more|additional|other)\b/i.test(count.phrase),
  );
  const distinct = [...new Set(unqualified.map((count) => count.value))];
  return distinct.length > 1 ? unqualified : null;
}

const BOOKING_CLAIM = /\b(i'?ll book|i will book|i'?ve booked|i have booked|i'?ve scheduled|i have scheduled|i'?ve arranged|i have arranged|i'?ve requested your ride|your ride is (booked|scheduled|confirmed)|booking is (complete|confirmed)|i'?ll (send|forward) (your|this) (information|details) to)\b/i;
const INTERNAL_XML = /<\/?(thinking|answer|reasoning|scratchpad|system)\b/i;
/**
 * Asking the rider their age — not merely mentioning it. Telling someone to confirm their age
 * with the provider is the opposite of badgering them for it, and the phrase-anywhere version of
 * this counted "you don't have to tell me, just confirm your age when you call" as a second ask.
 */
const AGE_QUESTION =
  /\bhow old\b[^.?!]*\?|\byour (?:exact )?age\b[^.?!]*\?|\bage in years\b[^.?!]*\?|\bwhat.{0,10}age\b|\b(?:need|tell me|give me|share|provide)\b[^.?!]{0,40}\byour (?:exact )?age\b/i;
const RETURN_TIME_QUESTION = /\breturn (time|trip)\b[^.?!]*\?|\bwhat time[^.?!]*(return|come back|head back)[^.?!]*\?|\bcoming back\b[^.?!]*\?/i;
/**
 * Any way of telling the rider that eligibility gets settled with the provider rather than here.
 * The first version demanded near-exact wording ("confirm your eligibility", "call them") and so
 * scored "each one will need to confirm that with you directly when you call" as a failure.
 */
const VERIFICATION_PATH =
  /verif|confirm (?:your |that |this |whether |if )?(?:eligib|you qualify|with (?:them|the provider))|check (?:your )?eligib|sort (?:it|that) out (?:directly )?with|(?:call|contact|ask|speak to) (?:them|the provider|each|all three)|(?:directly )?with them when you call|when you call/i;
const GEOGRAPHY_CONSTRAINT =
  /service[- ]area|covers? both|coverage|no provider.{0,40}(serves|covers)|outside .{0,20}service|county line|don'?t reach|can'?t reach|doesn'?t reach/i;
const SCHEDULE_CONSTRAINT = /service hours|operat(e|es|ing)|closed|don'?t run|doesn'?t run|not available on|hours are|too early/i;
const TIME_QUESTION =
  /what time\b[^.?!]*\?|\b(?:depart|leave|arrive by)\b[^.?!]*\?|\bwhen (?:would|do|should) you\b[^.?!]*\?/i;

function toolNames(attachments) {
  return (attachments || [])
    .map((attachment) => attachment?.metadata?.tool_name)
    .filter(Boolean);
}

function providerNamesIn(attachments) {
  const names = new Set();
  for (const attachment of attachments || []) {
    const data = attachment?.data;
    if (!data || typeof data !== 'object') continue;
    // `candidates` is what find_providers returns before the assistant assesses them; the other
    // three are the assessed buckets that assess_eligibility produces.
    for (const key of ['data', 'candidates', 'verification_required', 'excluded_providers']) {
      for (const provider of Array.isArray(data[key]) ? data[key] : []) {
        if (provider?.provider_name) names.add(String(provider.provider_name));
      }
    }
    for (const name of Array.isArray(data.provider_names) ? data.provider_names : []) {
      if (name) names.add(String(name));
    }
  }
  return names;
}

// ─── Assertions ─────────────────────────────────────────────────────────────

/**
 * Global assertions run against every assistant turn. Each returns null when it passes
 * or a short failure string naming what went wrong.
 */
const GLOBAL_ASSERTIONS = {
  responds: (turn) => (turn.message && turn.message.trim() ? null : 'empty assistant response'),

  no_contradictory_counts: (turn) => {
    const clash = contradictoryCounts(turn.message);
    return clash ? `message states ${clash.map((c) => `"${c.phrase}"`).join(' and ')}` : null;
  },

  no_booking_claim: (turn) => {
    const match = turn.message.match(BOOKING_CLAIM);
    return match ? `claims to book: "${match[0]}"` : null;
  },

  no_internal_xml: (turn) => {
    const match = turn.message.match(INTERNAL_XML);
    return match ? `leaked internal markup: "${match[0]}"` : null;
  },

  /**
   * A deterministic template that replaces the model's answer produces a broken record: the
   * rider says something new and gets the previous sentence back. Any repeat of the immediately
   * preceding reply is a failure to respond to what was just said.
   */
  advances_the_conversation: (turn, scenario, context) => {
    const previous = context.previousMessage;
    if (!previous || !turn.message) return null;
    const normalize = (value) => value.replace(/\s+/g, ' ').trim().toLowerCase();
    return normalize(previous) === normalize(turn.message)
      ? 'repeated the previous reply verbatim instead of responding to the new message'
      : null;
  },

  grounded_provider_names: (turn, scenario, context) => {
    if (!context.providerNames) return null;
    const known = context.providerNames;
    // Only flag a name that looks like a provider from our own vocabulary of distinctive
    // words but is not an actual provider — inventing "Contra Costa Senior Shuttle".
    const suspicious = [];
    for (const match of turn.message.matchAll(/\b([A-Z][A-Za-z'’-]+(?:\s+(?:of|the|and|de)?\s*[A-Z][A-Za-z'’-]+){1,4})\b/g)) {
      const phrase = match[1].trim();
      if (!/\b(Shuttle|Transit|Transport|Paratransit|Van|Ride|Rides|Express|Mobility|Taxi|Link|Connection|Wheels)\b/.test(phrase)) continue;
      const bare = (name) => name.replace(/\s*\([^)]*\)/g, '').trim();
      if (known.some((name) => name.includes(phrase) || phrase.includes(name))) continue;
      if (known.some((name) => bare(name) && (phrase.includes(bare(name)) || bare(name).includes(phrase)))) continue;
      // A real provider's name reordered ("San Ramon Senior Express Van" for "Senior Express Van
      // (San Ramon)") is a wording choice, not an invented operator. Compare word sets.
      const tokens = (value) => new Set(value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean));
      const phraseTokens = tokens(phrase);
      if (known.some((name) => {
        const nameTokens = tokens(name);
        const shared = [...phraseTokens].filter((token) => nameTokens.has(token)).length;
        return shared >= Math.min(phraseTokens.size, nameTokens.size);
      })) continue;
      if (/^(Public Transit|Transit|Public)$/i.test(phrase)) continue;
      // Places, not providers. Naming the stop a bus route uses ("San Ramon Transit Center",
      // "Richmond BART Station") is giving directions, not inventing an operator.
      if (/\b(Center|Centre|Station|Stop|Plaza|Terminal|Hub|Mall|Hospital|Medical|College|Hall)\b/.test(phrase)) continue;
      suspicious.push(phrase);
    }
    return suspicious.length ? `provider names not in data: ${[...new Set(suspicious)].join(', ')}` : null;
  },
};

/** Per-scenario assertions, keyed by the names listed in scenarios.json `checks`. */
const SCENARIO_ASSERTIONS = {
  finds_providers: (turns) => {
    const last = turns[turns.length - 1];
    const found = providerNamesIn(last.attachments);
    const searched = turns.some((turn) => toolNames(turn.attachments).includes('find_providers'));
    if (!searched) return 'never ran find_providers';
    if (found.size === 0) return 'search returned no named provider at all';
    // A search that never reached assess_eligibility produces candidates and no cards, so the
    // rider sees nothing however good the prose is.
    const assessed = turns.some((turn) => toolNames(turn.attachments).includes('assess_eligibility'));
    if (!assessed) return 'found candidates but never assessed them, so no provider was shown';
    return null;
  },

  /**
   * The safety property that replaced the server's three-bucket split: the assistant must return
   * a verdict for every candidate the search found. The server rejects an incomplete call, so a
   * failure here means it never recovered — some provider that matched the trip was never shown.
   */
  assesses_every_candidate: (turns) => {
    const candidates = new Set();
    const assessed = new Set();
    for (const turn of turns) {
      for (const attachment of turn.attachments || []) {
        const tool = attachment?.metadata?.tool_name;
        const data = attachment?.data;
        if (!data || typeof data !== 'object') continue;
        if (tool === 'find_providers') {
          for (const provider of Array.isArray(data.candidates) ? data.candidates : []) {
            if (provider?.provider_name) candidates.add(String(provider.provider_name));
          }
        }
        if (tool === 'assess_eligibility') {
          for (const key of ['data', 'verification_required', 'excluded_providers']) {
            for (const provider of Array.isArray(data[key]) ? data[key] : []) {
              if (provider?.provider_name) assessed.add(String(provider.provider_name));
            }
          }
        }
      }
    }
    if (candidates.size === 0) return null;
    const dropped = [...candidates].filter((name) => !assessed.has(name));
    return dropped.length ? `candidates never assessed: ${dropped.join(', ')}` : null;
  },

  /**
   * The reported bug: a rider asked about the "San Ramon Senior Express Van" and was told it was
   * not one of OPTIMAT's providers. The row is named "Senior Express Van (San Ramon)" and the
   * name lookup used a substring match, so it found nothing. The whole roster is in context now,
   * and a rider's phrasing of a real provider must never read as never heard of it.
   */
  recognizes_roster_provider: (turns) => {
    const last = turns[turns.length - 1];
    const denial = /\b(not (?:one of|a|among) (?:the |our )?providers?|not in (?:the )?(?:OPTIMAT|our) (?:system|network|database)|isn'?t (?:one of )?(?:a |our )?provider|don'?t have (?:any )?(?:data|information) on|no(?:t)? (?:a )?provider (?:in|we))\b/i;
    const match = last.message.match(denial);
    return match ? `denied a provider that is in the roster: "${match[0]}"` : null;
  },

  /**
   * A rider in Alamo is a Contra Costa County resident. The old parser checked county residency
   * against a hand-written set of city names that omitted every unincorporated community, so it
   * ruled Mobility Matters out and dropped it from the results entirely.
   */
  county_residency_recognized: (turns) => {
    for (const turn of turns) {
      for (const attachment of turn.attachments || []) {
        if (attachment?.metadata?.tool_name !== 'assess_eligibility') continue;
        const excluded = attachment?.data?.excluded_providers;
        const ruledOut = (Array.isArray(excluded) ? excluded : [])
          .find((provider) => /Mobility Matters/i.test(String(provider?.provider_name || '')));
        if (ruledOut && /resid|county|live/i.test(String(ruledOut.reason || ''))) {
          return `ruled out a county provider on residency for an in-county rider: "${ruledOut.reason}"`;
        }
      }
    }
    return null;
  },

  age_asked_at_most_once: (turns) => {
    const asks = turns.filter((turn) => AGE_QUESTION.test(turn.message)).length;
    return asks > 1 ? `asked for age ${asks} times` : null;
  },

  /**
   * Only wrong once the rider has said the trip is one-way. Before that the trip type is genuinely
   * unknown and "do you need a return trip?" is the right question — the first version of this
   * check flagged exactly that, on the opening turn.
   */
  no_return_time_question: (turns) => {
    const declaredOneWay = turns.findIndex((turn) => /\bone[- ]way\b/i.test(turn.user));
    if (declaredOneWay === -1) return null;
    const offender = turns.slice(declaredOneWay).find((turn) => RETURN_TIME_QUESTION.test(turn.message));
    return offender
      ? `asked for a return time after the rider said one-way: "${offender.message.match(RETURN_TIME_QUESTION)[0]}"`
      : null;
  },

  ends_with_usable_answer: (turns) => {
    const last = turns[turns.length - 1];
    // A usable ending either names providers or explains why it cannot; what it must not do
    // is ask the same blocked question again with nothing delivered.
    const namesProvider = providerNamesIn(last.attachments).size > 0;
    const explains = VERIFICATION_PATH.test(last.message) || GEOGRAPHY_CONSTRAINT.test(last.message) || SCHEDULE_CONSTRAINT.test(last.message);
    const onlyAsks = /\?\s*$/.test(last.message.trim()) && !namesProvider && !explains;
    return onlyAsks ? 'final turn only asks another question, delivering nothing' : null;
  },

  /**
   * Somewhere in the conversation, the rider must be told eligibility is settled with the
   * provider. Checking only the final turn punished a correct terse answer: asked "just tell me
   * who can take me", the assistant listed three names and phone numbers, having explained the
   * eligibility path in the turn before.
   */
  mentions_verification_path: (turns) => {
    const said = turns.some((turn) => VERIFICATION_PATH.test(turn.message));
    return said ? null : 'never told the rider how to resolve eligibility';
  },

  names_geography_constraint: (turns) => {
    const joined = turns.map((turn) => turn.message).join('\n');
    return GEOGRAPHY_CONSTRAINT.test(joined) ? null : 'zero results never named coverage as the binding constraint';
  },

  names_schedule_constraint: (turns) => {
    const joined = turns.map((turn) => turn.message).join('\n');
    return SCHEDULE_CONSTRAINT.test(joined) ? null : 'zero results never named service hours as the binding constraint';
  },

  /**
   * Most provider rows now carry service_hours, but not all of them do, and the schedule filter
   * passes the remainder through unchecked. A 5am Sunday pickup that survives on one of those
   * rows must be offered as something to confirm, not stated as available.
   */
  hedges_unconfirmed_hours: (turns) => {
    const last = turns[turns.length - 1];
    const hedges = /\b(confirm|check|verify|unknown|may not|might not|unusual)\b|\b(?:are ?n[o']t|is ?n[o']t|not|don'?t have)\s+(?:\w+\s+){0,3}(?:on file|listed|available|published)|don'?t have .{0,25}hours/i
      .test(last.message);
    return hedges ? null : 'presented an unusual hour as available without flagging that service hours are unconfirmed';
  },

  offers_alternative: (turns) => {
    const last = turns[turns.length - 1];
    const offersChange = /\b(instead|another day|different day|weekdays?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|earlier|later|public transit|BART|taxi|rideshare|one[- ]way|part of the way|as far as)\b/i
      .test(last.message);
    return offersChange ? null : 'no alternative or fallback offered when the trip could not be served';
  },

  no_time_questions_after_coverage_failure: (turns) => {
    const last = turns[turns.length - 1];
    return TIME_QUESTION.test(last.message) ? 'asked for trip times even though coverage already failed' : null;
  },

  /**
   * "my house in Antioch" and "DVC in Antioch" are both under-specified; either end may be the
   * one that resolves elsewhere. What matters is that a resolved-somewhere-else location is
   * raised with the rider instead of being searched silently.
   */
  flags_city_mismatch: (turns) => {
    const joined = turns.map((turn) => turn.message).join('\n');
    const flagged = /\bnot (?:in )?Antioch\b|resolved to|which .{0,20}(did you mean|location)|confirm (?:the|your) (?:destination|address|pickup)|Pleasant Hill/i.test(joined);
    return flagged ? null : 'searched an ambiguous location without raising that it resolves to another city';
  },

  payload_under_limit: (turns) => {
    const bytes = Math.max(...turns.map((turn) => JSON.stringify(turn.attachments || []).length));
    return bytes > 100_000 ? `attachment payload reached ${bytes} bytes` : null;
  },

  final_turn_answers_without_research: (turns) => {
    const last = turns[turns.length - 1];
    const tools = toolNames(last.attachments);
    const research = tools.filter((tool) => tool === 'find_providers' || tool === 'assess_eligibility');
    return research.length
      ? `re-ran the search to answer a question about the previous one (tools: ${tools.join(', ')})`
      : null;
  },

  final_turn_references_prior_search: (turns) => {
    const last = turns[turns.length - 1];
    const earlierNames = new Set();
    for (const turn of turns.slice(0, -1)) for (const name of providerNamesIn(turn.attachments)) earlierNames.add(name);
    if (earlierNames.size === 0) return 'no earlier search to reference';
    const referenced = [...earlierNames].some((name) => last.message.includes(name));
    return referenced ? null : 'final turn never named a provider from the earlier search';
  },

  answers_without_provider_search: (turns) => {
    const tools = turns.flatMap((turn) => toolNames(turn.attachments));
    return tools.includes('find_providers') ? 'ran a trip search for a general information question' : null;
  },

  no_trip_interrogation: (turns) => {
    const first = turns[0];
    const questions = (first.message.match(/\?/g) || []).length;
    return questions > 1 ? `asked ${questions} questions instead of answering the question` : null;
  },
};

// ─── Runner ─────────────────────────────────────────────────────────────────

async function runScenario(scenario, context) {
  const started = Date.now();
  const conversation = await post('/conversations', { title: `eval ${scenario.id}` });
  const conversationId = conversation?.data?.id || conversation?.id;
  if (!conversationId) throw new Error(`Could not create a conversation: ${JSON.stringify(conversation).slice(0, 200)}`);

  const turns = [];
  for (const [index, userMessage] of scenario.turns.entries()) {
    const turnStart = Date.now();
    const response = await post('/chat', { conversation_id: conversationId, message: userMessage });
    turns.push({
      index,
      user: userMessage,
      message: String(response?.message || ''),
      attachments: response?.attachments || [],
      latency_ms: Date.now() - turnStart,
      tools: toolNames(response?.attachments),
    });
  }

  const failures = [];
  for (const turn of turns) {
    const turnContext = { ...context, previousMessage: turns[turn.index - 1]?.message || null };
    for (const [name, assertion] of Object.entries(GLOBAL_ASSERTIONS)) {
      const failure = assertion(turn, scenario, turnContext);
      if (failure) failures.push({ assertion: name, turn: turn.index, detail: failure });
    }
  }
  for (const name of scenario.checks || []) {
    const assertion = SCENARIO_ASSERTIONS[name];
    if (!assertion) {
      failures.push({ assertion: name, turn: null, detail: 'assertion not implemented' });
      continue;
    }
    const failure = assertion(turns, scenario, context);
    if (failure) failures.push({ assertion: name, turn: null, detail: failure });
  }

  const questionsAsked = turns.reduce((total, turn) => total + (turn.message.match(/\?/g) || []).length, 0);

  return {
    id: scenario.id,
    title: scenario.title,
    conversation_id: conversationId,
    passed: failures.length === 0,
    failures,
    metrics: {
      turns: turns.length,
      questions_asked: questionsAsked,
      tool_calls: turns.reduce((total, turn) => total + turn.tools.length, 0),
      searches: turns.reduce((total, turn) => total + turn.tools.filter((tool) => tool === 'find_providers').length, 0),
      total_ms: Date.now() - started,
      max_turn_ms: Math.max(...turns.map((turn) => turn.latency_ms)),
      response_chars: turns.reduce((total, turn) => total + turn.message.length, 0),
    },
    turns,
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        results[index] = {
          id: items[index].id,
          title: items[index].title,
          passed: false,
          error: error.message,
          failures: [{ assertion: 'transport', turn: null, detail: error.message }],
          metrics: {},
          turns: [],
        };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

const { scenarios } = JSON.parse(readFileSync(resolve(__dirname, 'scenarios.json'), 'utf8'));
const selected = ONLY.length ? scenarios.filter((s) => ONLY.some((prefix) => s.id.startsWith(prefix))) : scenarios;

console.log(`Running ${selected.length} scenario(s) against ${BASE_URL} with concurrency ${CONCURRENCY}\n`);
const providerNames = await loadProviderNames();
const results = await mapWithConcurrency(selected, CONCURRENCY, (scenario) => runScenario(scenario, { providerNames }));

// ─── Report ─────────────────────────────────────────────────────────────────

const pad = (value, width) => String(value).padEnd(width);
console.log(`${pad('scenario', 28)}${pad('result', 8)}${pad('turns', 7)}${pad('asks', 6)}${pad('search', 8)}${pad('slowest', 9)}failures`);
console.log('-'.repeat(96));
for (const result of results) {
  console.log(
    pad(result.id, 28) +
      pad(result.passed ? 'PASS' : 'FAIL', 8) +
      pad(result.metrics.turns ?? '-', 7) +
      pad(result.metrics.questions_asked ?? '-', 6) +
      pad(result.metrics.searches ?? '-', 8) +
      pad(result.metrics.max_turn_ms ? `${(result.metrics.max_turn_ms / 1000).toFixed(1)}s` : '-', 9) +
      (result.failures.length ? result.failures.map((f) => f.assertion).join(', ') : ''),
  );
}

const failed = results.filter((result) => !result.passed);
if (failed.length) {
  console.log('\nFailure detail:');
  for (const result of failed) {
    console.log(`\n  ${result.id} — ${result.title}`);
    for (const failure of result.failures) {
      console.log(`    ✗ ${failure.assertion}${failure.turn === null ? '' : ` (turn ${failure.turn})`}: ${failure.detail}`);
    }
  }
}

const totals = {
  scenarios: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  assertion_failures: results.reduce((total, result) => total + result.failures.length, 0),
  questions_asked: results.reduce((total, result) => total + (result.metrics.questions_asked || 0), 0),
  searches: results.reduce((total, result) => total + (result.metrics.searches || 0), 0),
  response_chars: results.reduce((total, result) => total + (result.metrics.response_chars || 0), 0),
  slowest_turn_ms: Math.max(0, ...results.map((result) => result.metrics.max_turn_ms || 0)),
};

console.log(
  `\n${totals.passed}/${totals.scenarios} scenarios pass · ${totals.assertion_failures} assertion failures · ` +
    `${totals.questions_asked} questions asked · ${totals.searches} searches · slowest turn ${(totals.slowest_turn_ms / 1000).toFixed(1)}s`,
);

if (OUT) {
  const report = { target: BASE_URL, recorded_at: new Date().toISOString(), totals, results };
  writeFileSync(resolve(ROOT, OUT), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${OUT}`);
}

process.exitCode = failed.length ? 1 : 0;
