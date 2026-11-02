"""Normalize the three reviewed agency CSV exports; private outputs stay ignored."""
import argparse
import csv
from collections import Counter, defaultdict
from datetime import datetime
import hashlib
import json
import re
from pathlib import Path

from prepare_link import census_places, city, clock, literal, text, zip_code

VERSION = 'agencies-v1-city'
# These are agency-wide exports, not a verified split by paratransit product.
PROVIDERS = {'WESTCAT': (1003, 'WestCAT'), 'TDT': (1002, 'Tri Delta Transit'),
             'MM': (4021, 'Mobility Matters')}
HEADERS = {
    'WESTCAT': 'BookingID|Ldate|VehicleNumber|RunName|RunSortOrder|ClientID|Activity|SchedStatus|SchedTime|EstTime|ActArrTime|ActDepTime|AddressAlias|Address|City|ZipCode|TravelMeters from Prior Event|TravelSeconds From Prior Event|Odometer in Meters|PassOn|SpaceOn|PassOnBoard'.split('|'),
    'TDT': 'Type|SubT|Disposition|Date|BookingId|From|To|Req|SchTime|Neg|Est|Run|Distance|Transfer|ActArrO|ActDepO|ActArrD|ActDepD|Fare Amount|SpaceType|Para Service|VehicleTime|ItineraryID|Vehicle|From City|To City|Disability|EquipmentType|StopType|Scheduled|Est|Lock|Arrival|Departure|TripDist'.split('|'),
    'MM': 'Ride ID|Ride Date|Cancelled|Confirmed|# of Trips|Pickup Time|Appt Time|Est. Appt. Length|Appt. Type|Actual Hrs|Actual Mileage|Origin City|Origin Zip|Destination City|Destination Zip'.split('|'),
}


def value(v):
    return None if v is None or v.strip() in ('', 'NULL', '#N/A') else v.strip()


def local_clock(v):
    v = value(v)
    # PostgreSQL TIME cannot represent service-day hours beyond midnight.
    # Do not wrap these onto the wrong day or guess rollover for paired charts.
    if v and re.fullmatch(r'(?:2[4-9]|[3-9]\d):[0-5]\d(?::[0-5]\d)?', v):
        return None
    return clock(v)


def day(v, fmt):
    return datetime.strptime(v.strip(), fmt).strftime('%Y-%m-%d')


def endpoint(row, prefix, address, town, zipcode, places):
    town = city(value(town))
    lat, lng = places.get(town, (None, None))
    row.update({prefix + '_address': value(address), prefix + '_city': town,
                prefix + '_zip': zip_code(value(zipcode)), prefix + '_lat': lat, prefix + '_lng': lng})


def normalize(source, raw, places):
    """Return one row per WestCAT booking, TDT booking, or MM ride, never per leg."""
    rows = []
    notes = {}
    if source == 'WESTCAT':
        bookings = defaultdict(list)
        ignored = Counter()
        for index, r in raw:
            if r['Activity'] not in ('Pick', 'Drop'):
                ignored[r['Activity'] or '(blank)'] += 1
                continue
            if not value(r['BookingID']) or r['BookingID'] == '0':
                raise ValueError(f'Row {index}: missing booking identity')
            bookings[(r['Ldate'], r['BookingID'])].append((index, r))
        for events in bookings.values():
            picks = [(i, r) for i, r in events if r['Activity'] == 'Pick']
            drops = [(i, r) for i, r in events if r['Activity'] == 'Drop']
            if len(picks) != 1 or len(drops) > 1:
                raise ValueError('Ambiguous WestCAT booking; no import generated')
            index, p = picks[0]
            d = drops[0][1] if drops else None
            if d and d['ClientID'] != p['ClientID']:
                raise ValueError(f'Row {index}: inconsistent booking events')
            row = dict(source_row=index, service_date=day(p['Ldate'], '%Y%m%d'),
                       client_id=value(p['ClientID']), status=(p['SchedStatus'] + ' / ' + d['SchedStatus'])
                       if d and p['SchedStatus'] != d['SchedStatus'] else value(p['SchedStatus']),
                       pickup_arrive_time=local_clock(p['ActArrTime']), pickup_depart_time=local_clock(p['ActDepTime']),
                       dropoff_arrive_time=local_clock(d['ActArrTime']) if d else None,
                       dropoff_depart_time=local_clock(d['ActDepTime']) if d else None,
                       scheduled_time=local_clock(p['SchedTime']))
            endpoint(row, 'origin', p['Address'], p['City'], p['ZipCode'], places)
            endpoint(row, 'destination', d['Address'] if d else None, d['City'] if d else None,
                     d['ZipCode'] if d else None, places)
            rows.append(row)
        notes = dict(record_unit='booking', ignored_event_counts=dict(ignored),
                     pickup_only_bookings=sum(len(v) == 1 for v in bookings.values()),
                     pairing_note='Same-client same-day two-booking journeys with complete actual times and matching home address/ZIP only.')
    elif source == 'TDT':
        seen = set()
        for index, r in raw:
            key = (r['Date'], r['BookingId'])
            if not value(r['BookingId']) or key in seen:
                raise ValueError(f'Row {index}: missing or duplicate booking identity')
            seen.add(key)
            row = dict(source_row=index, service_date=day(r['Date'], '%m-%d-%Y'),
                       client_id=None, status=value(r['Disposition']),
                       pickup_arrive_time=local_clock(r['ActArrO']), pickup_depart_time=local_clock(r['ActDepO']),
                       dropoff_arrive_time=local_clock(r['ActArrD']), dropoff_depart_time=local_clock(r['ActDepD']),
                       scheduled_time=local_clock(r['SchTime']))
            endpoint(row, 'origin', r['From'], r['From City'], None, places)
            endpoint(row, 'destination', r['To'], r['To City'], None, places)
            rows.append(row)
        fields = ('ActArrO', 'ActDepO', 'ActArrD', 'ActDepD', 'SchTime')
        extended = sum(bool(value(r[f])) and local_clock(r[f]) is None for _, r in raw for f in fields)
        notes = dict(record_unit='booking', pairing_note='No client identifier or address ZIPs supplied; home/activity pairing is unavailable.',
                     extended_hour_fields=extended,
                     time_note='Service-day times at or beyond 24:00 are retained as missing clock times, without assuming a date rollover.')
    elif source == 'MM':
        seen = set()
        legs = 0
        for index, r in raw:
            ride = value(r['Ride ID'])
            if not ride or ride in seen:
                raise ValueError(f'Row {index}: missing or duplicate ride identity')
            seen.add(ride)
            if r['Cancelled'] not in ('YES', 'NO') or r['Confirmed'] not in ('YES', 'NO'):
                raise ValueError(f'Row {index}: unexpected ride status')
            trips = value(r['# of Trips'])
            if trips and (not trips.isdigit() or int(trips) < 1):
                raise ValueError(f'Row {index}: invalid trip count')
            legs += int(trips or 0)
            row = dict(source_row=index, service_date=day(r['Ride Date'], '%m/%d/%y'), client_id=None,
                       status='CANCELLED' if r['Cancelled'] == 'YES' else 'CONFIRMED' if r['Confirmed'] == 'YES' else 'UNCONFIRMED')
            endpoint(row, 'origin', None, r['Origin City'], r['Origin Zip'], places)
            endpoint(row, 'destination', None, r['Destination City'], r['Destination Zip'], places)
            rows.append(row)
        notes = dict(record_unit='ride', reported_trip_legs=legs,
                     missing_trip_count=sum(not value(r['# of Trips']) for _, r in raw),
                     pairing_note='No client IDs, addresses, or actual leg times supplied; home/activity pairing is unavailable.',
                     time_note='Pickup and appointment times lack AM/PM and are not actual vehicle times; not used for hourly or travel-time analysis. Rides with several trips are not expanded into invented legs.')
    else:
        raise ValueError('Unsupported source')
    return rows, notes


def prepare(source, path, places_path, output):
    with path.open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.reader(stream)
        headers = next(reader)
        if headers != HEADERS[source]:
            raise ValueError(f'{source}: headers differ from reviewed export')
        raw = []
        for index, values in enumerate(reader, 2):
            if not any(v.strip() for v in values):
                continue
            if len(values) != len(headers):
                raise ValueError(f'Row {index}: unexpected column count')
            # TDT has two Est columns; neither is used in this import.
            raw.append((index, dict(zip(headers, values))))
    rows, notes = normalize(source, raw, census_places(places_path))
    if not rows:
        raise ValueError('No importable records')
    provider_id, provider_name = PROVIDERS[source]
    file_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    places_hash = hashlib.sha256(places_path.read_bytes()).hexdigest()
    identity = hashlib.sha256(f'{VERSION}:{source}:{provider_id}:{file_hash}:{places_hash}'.encode()).hexdigest()
    for row in rows:
        row.update(import_id=identity, destination_city_source='source_city' if row['destination_city'] else 'unresolved')
    report = dict(source=source, provider_id=provider_id, provider_name=provider_name, filename=path.name,
                  import_id=identity, file_sha256=file_hash, parser_version=VERSION,
                  geographic_reference_sha256=places_hash, coordinate_precision='city_reference_point',
                  source_rows=len(raw), row_count=len(rows), timezone='America/Los_Angeles',
                  date_from=min(r['service_date'] for r in rows), date_to=max(r['service_date'] for r in rows),
                  status_counts=dict(Counter(r['status'] for r in rows)),
                  unique_clients=len({r['client_id'] for r in rows if r['client_id']}),
                  origin_mapped=sum(r['origin_lat'] is not None for r in rows),
                  destination_mapped=sum(r['destination_lat'] is not None for r in rows),
                  missing_pickup_time=sum(r.get('pickup_depart_time') is None for r in rows),
                  missing_dropoff_time=sum(r.get('dropoff_arrive_time') is None for r in rows),
                  unresolved_cities=sorted({r[p + '_city'] for r in rows for p in ('origin', 'destination') if r[p + '_city'] and r[p + '_lat'] is None}), **notes)
    target = output / source.lower()
    target.mkdir(parents=True, exist_ok=True)
    (target / 'quality-report.json').write_text(json.dumps(report, indent=2) + '\n')
    with (target / 'records.ndjson').open('w') as stream:
        for row in rows:
            stream.write(json.dumps(row, allow_nan=False) + '\n')
    with (target / 'import.sql').open('w') as stream:
        stream.write(f'BEGIN;\nSET LOCAL standard_conforming_strings = on;\nSELECT pg_advisory_xact_lock({provider_id},7052025);\n')
        stream.write(f"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM optimat.providers WHERE provider_id={provider_id} AND provider_name={literal(provider_name)}) THEN RAISE EXCEPTION 'Expected agency provider mapping is missing'; END IF; END $$;\n")
        stream.write('INSERT INTO optimat.operation_imports (id,source,filename,file_sha256,parser_version,provider_id,row_count,date_from,date_to,quality_report) VALUES (' + ','.join([
            literal(identity), literal(source), literal(path.name), literal(file_hash), literal(VERSION), str(provider_id), str(len(rows)), literal(report['date_from']), literal(report['date_to']), literal(json.dumps(report)) + '::jsonb']) + ') ON CONFLICT (id) DO NOTHING;\n')
        for start in range(0, len(rows), 500):
            payload = literal(json.dumps(rows[start:start + 500], allow_nan=False))
            stream.write(f'INSERT INTO optimat.operation_trips SELECT * FROM jsonb_populate_recordset(NULL::optimat.operation_trips,{payload}::jsonb) ON CONFLICT (import_id,source_row) DO NOTHING;\n')
        stream.write(f"DO $$ BEGIN IF (SELECT count(*) FROM optimat.operation_trips WHERE import_id={literal(identity)}) <> {len(rows)} THEN RAISE EXCEPTION 'Agency row-count reconciliation failed'; END IF; END $$;\n")
        stream.write(f'UPDATE optimat.operation_imports SET active=false WHERE source={literal(source)} AND provider_id={provider_id} AND active AND id<>{literal(identity)};\n')
        stream.write(f'UPDATE optimat.operation_imports SET active=true WHERE id={literal(identity)};\nCOMMIT;\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--westcat', type=Path, required=True)
    parser.add_argument('--tdt', type=Path, required=True)
    parser.add_argument('--mm', type=Path, required=True)
    parser.add_argument('--places-dbf', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path(__file__).parent / 'output' / 'agencies')
    args = parser.parse_args()
    reports = [prepare(source, getattr(args, source.lower()), args.places_dbf, args.output) for source in PROVIDERS]
    print(json.dumps(reports, indent=2))
