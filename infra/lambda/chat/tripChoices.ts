// Local choices and route-planner links require no external API calls.
export function clarifyTripTime(input: unknown) {
  const time = (input as { time?: unknown })?.time;
  if (typeof time !== 'string' || !time.trim() || time.length > 80) return { success: false, error: 'Provide the rider’s stated time (up to 80 characters).' };
  const value = time.trim();
  return { success: true, data: { question: `What does ${value} mean for your trip?`, options: [
    { label: 'Pickup time', message: `${value} is my requested pickup time.` },
    { label: 'Arrival time', message: `I need to arrive by ${value}. This is not my pickup time.` },
  ] } };
}
export function routePlanner(input: unknown) {
  const args = input as { mode?: unknown; origin?: unknown; destination?: unknown };
  if (!args || !['transit', 'bicycling'].includes(String(args.mode))) return { success: false, error: 'Choose transit or bicycling.' };
  const params = new URLSearchParams({ api: '1', travelmode: String(args.mode) });
  for (const key of ['origin', 'destination'] as const) {
    const value = args[key];
    if (value !== undefined && (typeof value !== 'string' || value.length > 300)) return { success: false, error: 'Locations must be text of up to 300 characters.' };
    if (typeof value === 'string' && value.trim()) params.set(key, value.trim());
  }
  return { success: true, data: { mode: args.mode, url: `https://www.google.com/maps/dir/?${params}` } };
}

// Recognize the common explicit trip-request form without interpreting dates,
// provider hours or route-only questions as a rider's requested time.
export function ambiguousTripTime(message: string): string | null {
  if (!/\b(?:need|want|looking for|find)\b[^.!?\n]{0,80}\b(?:ride|transportation)\b/i.test(message) || /\b(?:bicycle|cycling|bike|bus|train) directions\b/i.test(message)) return null;
  const match = /\bat\s+(noon|midnight|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))\b/i.exec(message);
  if (!match) return null;
  if (/\b(?:pick(?:ed)?\s*up|pickup|depart(?:ure|ing)?|leave|arriv(?:e|al|ing)|appointment)\b/i.test(message)) return null;
  return match[1].trim();
}
