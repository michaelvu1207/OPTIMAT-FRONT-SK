-- WestCAT publishes different reservation windows for local and regional trips.
-- Local ADA and Senior Dial-A-Ride trips are booked 1-3 days ahead. ADA regional
-- trips outside WestCAT's area may be booked up to two weeks ahead.

UPDATE optimat.providers
SET schedule_type = jsonb_build_object(
      'type', 'in-advance-book',
      'advance_notice', '1-3 days',
      'regional_advance_notice', 'up to 14 days',
      'regional_advance_notice_note', 'Regional trips outside the WestCAT area may be booked up to two weeks before the appointment.',
      'source_url', 'https://www.westcat.org/Content/pdf/REVADA-Paratransit-Guide.pdf'
    ),
    updated_at = now()
WHERE provider_id = 2007
   OR regexp_replace(lower(provider_name), '[^a-z0-9]', '', 'g') = 'westcatparatransit';

UPDATE optimat.providers
SET schedule_type = jsonb_build_object(
      'type', 'in-advance-book',
      'advance_notice', '1-3 days',
      'source_url', 'https://www.westcat.org/Content/pdf/REVSenior-Dial-A-Ride-Guide.pdf'
    ),
    updated_at = now()
WHERE provider_id = 2008
   OR regexp_replace(lower(provider_name), '[^a-z0-9]', '', 'g') IN (
     'westcatseniordialaride',
     'westcatdialaride'
   );

-- Preserve the existing Tri Delta geometry for audit/comparison, but mark why the
-- API quarantines it from public service-area display pending stakeholder review.
UPDATE optimat.providers
SET service_area_notes = concat_ws(
      ' ',
      nullif(service_area_notes, ''),
      'Public display quarantined on 2026-08-18: the current polygon is not an approved representation of the fixed-route network. Compare against https://www.trideltatransit.com/local-and-express-routes/system-map/ before replacing it.'
    ),
    updated_at = now()
WHERE (provider_id = 1002 OR regexp_replace(lower(provider_name), '[^a-z0-9]', '', 'g') = 'trideltatransit')
  AND regexp_replace(lower(coalesce(provider_type, '')), '[^a-z0-9]', '', 'g') = 'fixedroute';
