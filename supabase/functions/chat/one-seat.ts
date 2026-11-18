type ProviderRow = { provider_name?: unknown; name?: unknown; is_operating?: boolean | null; [key: string]: unknown };

function key(provider: ProviderRow): string {
  return String(provider.provider_name || provider.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isOneSeat(provider: ProviderRow): boolean {
  return ['oneseatride', 'oneseatregionalride'].includes(key(provider));
}

// OPTIMAT's regional jurisdiction policy: west, central, east, and Tri-Valley.
// Municipal west-area polygons also describe the Richmond/San Pablo end of a
// regional trip. They do not make those municipal services cross-agency rides.
function jurisdiction(provider: ProviderRow): string | null {
  const name = key(provider);
  if (['westcatparatransit', 'westcatseniordialaride', 'rtransitrichmond', 'sanpabloseniordisabledtransportation'].includes(name)) return 'west';
  if (['linkparatransit', 'countyconnectionlink', 'countyconnectionlinkparatransit'].includes(name)) return 'central';
  if (['tdtadaparatransit', 'tdtseniorparatransit', 'trideltatransitadaparatransit'].includes(name)) return 'east';
  if (['lavtadialaride', 'lavtaparatransit', 'wheelsdialaride'].includes(name)) return 'tri-valley';
  return null;
}

/** Use agency polygons, never a change of city or the rider's residence. */
export function oneSeatTripPolicy<T extends ProviderRow>(
  providers: T[], covers: (provider: T, end: 'origin' | 'destination') => boolean,
): { recommend: boolean; reason_code: string; origin_regions: string[]; destination_regions: string[] } {
  const origin = new Set<string>();
  const destination = new Set<string>();
  for (const provider of providers) {
    if (provider.is_operating === false) continue;
    const region = jurisdiction(provider);
    if (!region) continue;
    if (covers(provider, 'origin')) origin.add(region);
    if (covers(provider, 'destination')) destination.add(region);
  }
  const same = [...origin].some(region => destination.has(region));
  const cross = origin.size > 0 && destination.size > 0 && !same;
  return {
    recommend: cross,
    reason_code: same ? 'single_agency_covers_trip' : cross ? 'cross_agency_connection' : 'unconfirmed_agency_coverage',
    origin_regions: [...origin], destination_regions: [...destination],
  };
}

/** The old import's $3 flat fare and disability-only text are obsolete. */
export function normalizeOneSeat<T extends ProviderRow>(provider: T): T {
  if (!isOneSeat(provider)) return provider;
  return {
    ...provider,
    provider_type: 'ADA Paratransit',
    eligibility_reqs: 'ADA paratransit eligibility is required. Age 65+ alone does not establish eligibility. Confirm regional trip availability with One Seat Regional Ride.',
    booking: { method: 'call', details: '(925) 680-2134', instructions: 'Confirm both trip legs, pickup coverage, times, and fare with One Seat Regional Ride.' },
    fare: { type: 'variable', cost: 'Based on the agency where each trip begins; confirm each way when booking.' },
    website: 'https://oneseatride.org/',
  };
}
