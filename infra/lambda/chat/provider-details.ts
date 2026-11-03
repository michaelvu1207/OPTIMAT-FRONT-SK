// Provider detail responses are a rider-facing projection, not database exports.
// Unknown fields are excluded at every level, including imported nested metadata.
type Shape = true | { [key: string]: Shape } | [Shape];
const application: Shape = {
  required: true,
  processing_time: { kind: true, value: true, minimum: true, maximum: true, unit: true },
  instructions: true, source_url: true, verified_at: true,
};
const eligibility: Shape = {
  eligibility: true, eligibility_text: true, proof: true, proof_process: true,
  type: true, eligibility_reqs: [{ type: true, proof: true }],
};
const fields: Shape = {
  provider_name: true, provider_type: true, routing_type: true, phone: true,
  eligibility_reqs: eligibility, eligibility_requirement: eligibility,
  schedule_type: { type: true, advance_notice: true, regional_advance_notice: true },
  booking: { method: true, details: true, instructions: true, phone: true, application },
  fare: { type: true, cost: true, payment: true },
  contacts: [{ name: true, phone: true, email: true }],
  service_hours: { hours: [{ day: true, start: true, end: true }] },
  website: true, service_area_cities: [true],
};

function project(value: unknown, shape: Shape): unknown {
  if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
    // Preserve legacy text fields and parse legacy serialized objects safely.
    try { value = JSON.parse(value); } catch { return value; }
  }
  if (value === null || typeof value !== 'object') {
    return ['string', 'number', 'boolean'].includes(typeof value) || value === null ? value : undefined;
  }
  if (shape === true) return undefined;
  if (Array.isArray(value)) {
    const itemShape = Array.isArray(shape) ? shape[0] : shape;
    return value.map(item => project(item, itemShape)).filter(item => item !== undefined);
  }
  if (Array.isArray(shape)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, childShape] of Object.entries(shape)) {
    if (!Object.hasOwn(value, key)) continue;
    const child = project((value as Record<string, unknown>)[key], childShape);
    if (child !== undefined) result[key] = child;
  }
  return result;
}

export function riderProviderDetails(value: unknown): unknown {
  const result = project(value, fields);
  if (Array.isArray(result)) return result.filter(item => item && typeof item === 'object' && !Array.isArray(item));
  return result && typeof result === 'object' ? result : null;
}
