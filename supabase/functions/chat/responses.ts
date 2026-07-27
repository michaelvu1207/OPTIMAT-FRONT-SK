export function buildNoProviderResponse(providerSearch: Record<string, unknown>): string | null {
  if (providerSearch.status === "clarification_required") {
    return typeof providerSearch.message === "string"
      ? providerSearch.message
      : "I need one more trip detail before I can search providers.";
  }

  const providers = Array.isArray(providerSearch.data) ? providerSearch.data : [];
  const totalFound =
    typeof providerSearch.total_found === "number" ? providerSearch.total_found : providers.length;

  if (totalFound !== 0) return null;

  const sourceAddress =
    typeof providerSearch.source_address === "string" ? providerSearch.source_address : "the pickup address";
  const destinationAddress =
    typeof providerSearch.destination_address === "string"
      ? providerSearch.destination_address
      : "the destination address";
  const hasPublicTransit = Boolean(providerSearch.public_transit);
  const diagnostics =
    providerSearch.diagnostics && typeof providerSearch.diagnostics === "object"
      ? providerSearch.diagnostics as Record<string, unknown>
      : {};
  const geographyMatches = Number(diagnostics.geography_match_count || 0);
  const scheduleMatches = Number(diagnostics.schedule_match_count || 0);
  const verificationCount = Number(diagnostics.verification_required_count || 0);
  const excluded = Array.isArray(providerSearch.excluded_providers)
    ? providerSearch.excluded_providers as Array<Record<string, unknown>>
    : [];

  const lines: string[] = [];

  if (hasPublicTransit) {
    lines.push("I found 1 transportation provider option: Public Transit.", "");
  }

  if (geographyMatches === 0) {
    lines.push(
      "I couldn't find a direct provider in our current data whose service area covers both locations.",
      "Changing the travel time will not fix this coverage constraint.",
    );
  } else if (scheduleMatches === 0) {
    lines.push(
      `${geographyMatches} provider service area${geographyMatches === 1 ? "" : "s"} cover both locations, but none operate for the requested date and trip time.`,
    );
  } else if (verificationCount > 0 && excluded.length === 0) {
    lines.push(
      `I found ${verificationCount} provider${verificationCount === 1 ? "" : "s"} covering this trip, but eligibility needs to be verified before I can recommend them.`,
    );
  } else {
    lines.push(
      `${scheduleMatches} provider${scheduleMatches === 1 ? "" : "s"} cover the trip and requested schedule, but none match the eligibility information provided.`,
    );
    for (const provider of excluded.slice(0, 3)) {
      const name = typeof provider.provider_name === "string" ? provider.provider_name : "Provider";
      const reason = typeof provider.reason === "string" ? provider.reason : "Eligibility did not match.";
      lines.push(`${name}: ${reason}`);
    }

    if (verificationCount > 0) {
      lines.push(
        `${verificationCount} additional provider${verificationCount === 1 ? "" : "s"} may cover the trip but require eligibility verification.`,
      );
    }
  }

  lines.push("", `Pickup: ${sourceAddress}`, `Destination: ${destinationAddress}`);

  if (hasPublicTransit) {
    lines.push("", "Open the results to review its itinerary and display the transit route on the map.");
  }

  return lines.join("\n");
}

export function ensurePublicTransitProviderSummary(
  response: string,
  providerSearch: Record<string, unknown> | null,
): string {
  if (!providerSearch?.public_transit || providerSearch.status !== "complete") return response;
  if (/transportation provider option[^\n]*Public Transit/i.test(response)) return response;

  const directProviders = Array.isArray(providerSearch.data) ? providerSearch.data.length : 0;
  const totalOptions = directProviders + 1;
  const summary = `I found ${totalOptions} transportation provider ${
    totalOptions === 1 ? "option" : "options"
  }, including Public Transit.`;
  return response ? `${summary}\n\n${response}` : summary;
}

/**
 * Providers whose eligibility could not be confirmed must never vanish from the answer.
 * When the model omits them, state them deterministically instead.
 */
export function ensureVerificationSummary(
  response: string,
  providerSearch: Record<string, unknown> | null,
): string {
  if (providerSearch?.status !== "complete") return response;
  const verification = Array.isArray(providerSearch.verification_required)
    ? providerSearch.verification_required as Array<Record<string, unknown>>
    : [];
  if (verification.length === 0) return response;

  const names = verification
    .map((provider) => (typeof provider.provider_name === "string" ? provider.provider_name : null))
    .filter((name): name is string => Boolean(name));
  if (names.length === 0) return response;
  if (names.every((name) => response.includes(name))) return response;

  const note = `${names.length === 1 ? "One more provider serves" : `${names.length} more providers serve`} this trip but ${
    names.length === 1 ? "needs" : "need"
  } eligibility verification: ${names.join(", ")}. Contact them directly to confirm whether you qualify.`;
  return response ? `${response}\n\n${note}` : note;
}

export function buildCoverageResponse(coverage: Record<string, unknown> | null): string | null {
  if (!coverage) return null;
  if (coverage.status === "clarification_required" && typeof coverage.message === "string") {
    return coverage.message;
  }
  if (coverage.status !== "not_covered") return null;

  const source = typeof coverage.source_address === "string" ? coverage.source_address : "the pickup location";
  const destination =
    typeof coverage.destination_address === "string" ? coverage.destination_address : "the destination";
  return [
    "I couldn't find a direct provider in our current data whose service area covers both locations.",
    `Pickup: ${source}`,
    `Destination: ${destination}`,
    "Changing the date or time will not fix this coverage constraint, so I won't ask you for unnecessary return-trip details. Public transit may still be an option.",
  ].join("\n");
}

export function buildDateResolutionResponse(dateResolution: Record<string, unknown> | null): string | null {
  if (!dateResolution) return null;
  if (dateResolution.status === "clarification_required" && typeof dateResolution.message === "string") {
    return dateResolution.message;
  }
  if (dateResolution.status !== "resolved") return null;

  const raw = typeof dateResolution.travel_date_raw === "string" ? dateResolution.travel_date_raw : "that date";
  const display = typeof dateResolution.travel_date_display === "string"
    ? dateResolution.travel_date_display
    : dateResolution.travel_date;
  if (typeof display !== "string") return null;

  return [
    `I resolved “${raw}” as ${display} using the California service clock, and I'll use that date.`,
    "Please provide any remaining trip details I asked for, such as one-way or round trip, the outbound time and whether it means depart at or arrive by, and rider eligibility.",
  ].join("\n");
}
