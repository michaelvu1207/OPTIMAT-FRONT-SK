import { createHash } from 'node:crypto';
import type { TurnContext } from './tools.js';

export const YES_NO_OPTIONS = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'declined', label: 'Would rather not say' },
] as const;
export type BinaryAnswer = 'yes' | 'no' | 'declined';
export interface BinaryQuestion { id: string; question: string; answer?: BinaryAnswer }

// Only these unambiguous positive questions update eligibility booleans.
export function eligibilityField(question: string): 'disabled' | 'veteran' | undefined {
  if (/^do you have (?:a |any )?disabilit(?:y|ies)\?$/i.test(question)) return 'disabled';
  if (/^are you (?:a |an )?(?:military )?veteran\?$/i.test(question)) return 'veteran';
}

export function registerQuestion(turn: TurnContext, raw: unknown): BinaryQuestion | null {
  if (typeof raw !== 'string') return null;
  const question = raw.trim().replace(/\s+/g, ' ');
  if (!question || question.length > 500 || !question.endsWith('?')) return null;
  // An open-ended request for details is not a binary question.
  if (!/^(?:do|does|did|are|is|was|were|have|has|will|would|should|can|could)\b/i.test(question) ||
      /^(?:can|could|would|will) you (?:please )?(?:tell|share|provide|give|enter|select|choose)\b/i.test(question)) return null;
  const field = eligibilityField(question);
  if (field && (typeof turn.riderEligibility[field] === 'boolean' || turn.riderEligibility.declined_facts?.includes(field))) return null;
  const id = createHash('sha256').update(question.toLowerCase()).digest('hex').slice(0, 24);
  turn.binaryQuestions ||= [];
  const existing = turn.binaryQuestions.find(item => item.id === id);
  if (existing) return existing.answer ? null : existing;
  const item = { id, question };
  turn.binaryQuestions.push(item);
  return item;
}

export function questionsFromText(turn: TurnContext, text: string): BinaryQuestion[] {
  const questions: BinaryQuestion[] = [];
  for (const match of text.matchAll(/(?:^|(?<=[.!?\n]))\s*(?:[-*]\s*)?((?:Do|Does|Did|Are|Is|Was|Were|Have|Has|Will|Would|Should|Can|Could)\b[^?!.\n]{1,498}\?)/gi)) {
    const question = registerQuestion(turn, match[1]);
    if (question) questions.push(question);
  }
  return questions;
}

export function applyBinaryAnswer(turn: TurnContext, input: unknown): BinaryQuestion | null {
  if (!input || typeof input !== 'object') return null;
  const { question_id, answer } = input as Record<string, unknown>;
  if (!YES_NO_OPTIONS.some(option => option.value === answer)) return null;
  const question = turn.binaryQuestions?.find(item => item.id === question_id);
  if (!question) return null;
  question.answer = answer as BinaryAnswer;
  const field = eligibilityField(question.question);
  if (field) {
    turn.riderEligibility.declined_facts = (turn.riderEligibility.declined_facts || []).filter(item => item !== field);
    if (answer === 'declined') {
      turn.riderEligibility[field] = null;
      turn.riderEligibility.declined_facts.push(field);
    } else turn.riderEligibility[field] = answer === 'yes';
  }
  return question;
}

export function binaryFactsBlock(turn: TurnContext): string {
  return 'Explicit button answers (authoritative unless the rider corrects them): ' + JSON.stringify(
    (turn.binaryQuestions || []).filter(item => item.answer).map(({ question, answer }) => ({ question, answer }))
  ) + '. declined means unknown, never No or consent. Do not ask the same fact again after a refusal. Continue with other details and explain provider verification where needed.';
}

// Bind short typed answers only when there is exactly one unanswered question.
// Explicit statements also allow corrections without forcing button use.
export function applyTypedBinaryAnswer(turn: TurnContext, message: string): void {
  message = message.replace(/\bI[’']m\b/gi, 'I am');
  const pending = (turn.binaryQuestions || []).filter(item => !item.answer);
  const short = message.trim().replace(/[.!]$/, '').toLowerCase();
  const value = /^(yes|yeah|yep)$/.test(short) ? 'yes' : /^(no|nope)$/.test(short) ? 'no'
    : /^(?:i (?:would )?(?:rather|prefer) not (?:to )?(?:say|answer|share)|would rather not say)$/.test(short) ? 'declined' : undefined;
  if (value && pending.length === 1) applyBinaryAnswer(turn, { question_id: pending[0].id, answer: value });
  const statements = [
    { question: 'Are you a veteran?', yes: /\bi am (?:a |an )?(?:military )?veteran\b/i, no: /\bi am not (?:a |an )?(?:military )?veteran\b/i },
    { question: 'Do you have a disability?', yes: /\bi (?:have a disability|am disabled)\b/i, no: /\bi (?:do not have a disability|don't have a disability|am not disabled)\b/i },
  ];
  for (const item of statements) {
    const answer = item.no.test(message) ? 'no' : item.yes.test(message) ? 'yes' : undefined;
    if (!answer) continue;
    let question = turn.binaryQuestions?.find(question => question.question === item.question);
    if (!question) {
      // Registration may be suppressed by an existing fact; no need to change it here.
      question = registerQuestion(turn, item.question) || undefined;
    }
    if (question) applyBinaryAnswer(turn, { question_id: question.id, answer });
  }
}
