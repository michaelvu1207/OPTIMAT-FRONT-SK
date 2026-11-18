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
  // A single answer cannot identify which branch of a compound question applies.
  if ((question.match(/\?/g) || []).length !== 1 ||
      /\b(?:or|and)\s+(?:do|does|did|are|is|was|were|have|has|will|would|should|can|could)\b/i.test(question)) return null;
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
    for (const related of turn.binaryQuestions || []) {
      if (eligibilityField(related.question) === field) related.answer = answer as BinaryAnswer;
    }
    turn.riderEligibility.declined_facts = (turn.riderEligibility.declined_facts || []).filter(item => item !== field);
    if (answer === 'declined') {
      turn.riderEligibility[field] = null;
      turn.riderEligibility.declined_facts.push(field);
    } else turn.riderEligibility[field] = answer === 'yes';
  }
  return question;
}

export function binaryFactsBlock(turn: TurnContext): string {
  return 'Explicit rider answers, from buttons or text (authoritative unless the rider corrects them): ' + JSON.stringify(
    (turn.binaryQuestions || []).filter(item => item.answer).map(({ question, answer }) => ({ question, answer }))
  ) + '. declined means unknown, never No or consent. Do not ask the same fact again after a refusal. Continue with other details and explain provider verification where needed.';
}

// Bind short typed answers only when there is exactly one unanswered question.
// Explicit statements also allow corrections without forcing button use.
export function applyTypedBinaryAnswer(turn: TurnContext, message: string): void {
  message = message.replace(/[’]/g, "'").replace(/\bI'm\b/gi, 'I am').replace(/\bI'd\b/gi, 'I would');
  const pending = (turn.binaryQuestions || []).filter(item => !item.answer);
  const short = message.trim().replace(/[.!]$/, '').toLowerCase();
  const value = /^(yes|yeah|yep)$/.test(short) ? 'yes' : /^(no|nope)$/.test(short) ? 'no'
    : /^(?:i (?:would )?(?:rather|prefer) not (?:to )?(?:say|answer|share)|would rather not say)$/.test(short) ? 'declined' : undefined;
  if (value && pending.length === 1) applyBinaryAnswer(turn, { question_id: pending[0].id, answer: value });
  const statements = [
    { question: 'Are you a veteran?', topic: /\bveteran(?: status)?\b/i, yes: /^i am (?:a |an )?(?:military )?veteran\b/i, no: /^i am not (?:a |an )?(?:military )?veteran\b/i },
    { question: 'Do you have a disability?', topic: /\b(?:disabilit(?:y|ies)|disabled)\b/i, yes: /^i (?:have a disability|am disabled)\b/i, no: /^i (?:do not have a disability|don't have a disability|am not disabled)\b/i },
  ];
  const setFact = (questionText: string, answer: BinaryAnswer) => {
    turn.binaryQuestions ||= [];
    let question = turn.binaryQuestions.find(q => q.question.toLowerCase() === questionText.toLowerCase());
    if (!question) {
      question = { id: createHash('sha256').update(questionText.toLowerCase()).digest('hex').slice(0, 24), question: questionText };
      turn.binaryQuestions.push(question);
    }
    applyBinaryAnswer(turn, { question_id: question.id, answer });
  };
  // Evaluate clauses, not substrings: "whether I have a disability" is not an
  // assertion. A refusal controls its entire clause, even with embedded yes/no words.
  const refusal = /\b(?:(?:i\s+)?(?:would\s+)?(?:rather|prefer)\s+not\s+(?:to\s+)?(?:say|answer|share|disclose)|i\s+(?:don't|do not)\s+want\s+to\s+(?:say|answer|share|disclose)|i\s+decline\s+to\s+(?:say|answer|share|disclose))\b/i;
  for (const raw of message.split(/[.!?;\n]+|\bbut\b|,?\s+and\s+(?=I\b)/i)) {
    const clause = raw.trim().replace(/^(?:(?:actually|yes|no|to clarify)[,:]?\s+)+/i, '');
    if (refusal.test(clause)) {
      const topics = statements.filter(item => item.topic.test(clause));
      for (const item of topics) setFact(item.question, 'declined');
      if (!topics.length && pending.length === 1) applyBinaryAnswer(turn, { question_id: pending[0].id, answer: 'declined' });
      continue;
    }
    for (const item of statements) {
      const answer = item.no.test(clause) ? 'no' : item.yes.test(clause) ? 'yes' : undefined;
      if (answer) setFact(item.question, answer);
    }
  }
}
