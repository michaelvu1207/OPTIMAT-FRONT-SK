// Resolve explicit municipal pass names before the model can confuse them with
// standard Lyft service. Prices always come from the current provider record.
export function namedMunicipalPass(message: string): string | null {
  const normalized = message.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!/\bwalnut creek\b/.test(normalized)) return null;
  if (/\b(?:lyft|lift) concierge(?: pass)?\b/.test(normalized)) return 'Walnut Creek Lyft Concierge Pass';
  if (/\b(?:lyft|lift) self access(?: pass)?\b/.test(normalized)) return 'Walnut Creek Lyft Self Access Pass';
  return null;
}
