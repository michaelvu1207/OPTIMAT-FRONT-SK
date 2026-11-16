"""Build private address batches and coarse cells. Never publish the output directory."""
import argparse
import csv
import hashlib
import io
import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path
import urllib.request

from prepare_agencies import normalize, PROVIDERS
from prepare_link import census_places, city, clock, service_date, text, literal, address_key

FILES = {'LINK': '[New]_LINK-070125.xlsx - in (1).csv',
         'WESTCAT': '[New]_WestCat_Trip Dump 2025_v1.csv',
         'TDT': '[New]_TDT-Trip Repot.xlsx - Trapeze.csv',
         'MM': '[New]_MM_7.1.25-12.31.25 Rides.xlsx - Page1.csv'}


def address(value):
    value = (value or '').upper().strip()
    # Trapeze exports a place alias followed by a colon and "number, street".
    if ':' in value:
        value = value.rsplit(':', 1)[1].strip()
    value = re.sub(r'^(\d+)\s*,\s*', r'\1 ', value)
    value = re.sub(r'\s+', ' ', value)
    # Number ranges are not single addresses. Do not invent a midpoint house number.
    if re.match(r'^\d+\s*[-–]\s*\d+', value):
        return None, 'address_range'
    if not re.match(r'^\d+\s+\S+', value):
        return None, 'not_street_address'
    return value, 'street_address'


def cell(lat, lng):
    # Fixed one-kilometre grid in a local equirectangular projection at 38 N.
    x = math.floor(math.radians(lng) * 6371000 * math.cos(math.radians(38)) / 1000)
    y = math.floor(math.radians(lat) * 6371000 / 1000)
    return x, y


def read_sources(folder, places):
    all_rows = []
    for source, filename in FILES.items():
        with (folder / filename).open(encoding='utf-8-sig', newline='') as stream:
            raw = [(i, r) for i, r in enumerate(csv.DictReader(stream), 2) if any(r.values())]
        if source == 'LINK':
            towns = defaultdict(set)
            for _, r in raw:
                key = address_key(r['PickUpAddress'], r['PickupZipCode'])
                if key and city(r['PickupCity']):
                    towns[key].add(city(r['PickupCity']))
            rows = []
            for i, r in raw:
                candidates = towns.get(address_key(r['DropOffAddress'], r['DropOffZipCode']), set())
                dest = next(iter(candidates)) if len(candidates) == 1 else None
                rows.append(dict(source_row=i, service_date=service_date(r['TripDate']),
                    client_id=text(r['ClientID']), status=text(r['Status']),
                    origin_address=text(r['PickUpAddress']), origin_city=city(r['PickupCity']), origin_zip=r['PickupZipCode'],
                    destination_address=text(r['DropOffAddress']), destination_city=dest, destination_zip=r['DropOffZipCode'],
                    pickup_depart_time=clock(r['PickupDepartTime']), dropoff_arrive_time=clock(r['DropOffArriveTime']),
                    pickup_arrive_time=clock(r['PickupArriveTime']), dropoff_depart_time=clock(r['DropOffDepartTime'])))
        else:
            rows, _ = normalize(source, raw, places)
        for r in rows:
            r.update(source=source, provider_id=2006 if source == 'LINK' else PROVIDERS[source][0])
            for kind in ('origin', 'destination'):
                coords = places.get(r.get(kind + '_city'), (None, None))
                if source == 'LINK' and not r.get(kind + '_address'):
                    coords = (None, None)
                r[kind + '_lat'], r[kind + '_lng'] = coords
            all_rows.append(r)
    return all_rows


def geocode(batch, target):
    """Only address fields and opaque IDs leave the machine. Explicit CLI opt-in."""
    boundary = 'optimat-census-batch'
    buf = io.StringIO(newline='')
    writer = csv.writer(buf)
    for key, a in batch:
        writer.writerow([key, a['street'], a['city'], 'CA', a['zip']])
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="benchmark"\r\n\r\nPublic_AR_Current\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="addressFile"; filename="addresses.csv"\r\nContent-Type: text/csv\r\n\r\n'
            + buf.getvalue() + f'\r\n--{boundary}--\r\n').encode()
    req = urllib.request.Request('https://geocoding.geo.census.gov/geocoder/locations/addressbatch', data=body,
        headers={'Content-Type': 'multipart/form-data; boundary=' + boundary})
    with urllib.request.urlopen(req, timeout=240) as response:
        result = response.read().decode('utf-8-sig')
    parsed = list(csv.reader(io.StringIO(result)))
    expected = {key for key, _ in batch}
    if {r[0] for r in parsed if r} != expected or len(parsed) != len(expected):
        raise ValueError('Incomplete Census response; no batch cache saved')
    cache = {}
    for r in parsed:
        entry = {'status': r[2]}
        if r[2] == 'Match':
            lng, lat = map(float, r[5].split(','))
            if not (32 <= lat <= 43 and -125 <= lng <= -114):
                entry['status'] = 'outside_california'
            else:
                entry.update(lat=lat, lng=lng, precision='census_street_interpolation',
                             matched_street=re.sub(r'^\d+\s+', '', r[4]))
        cache[r[0]] = entry
    target.write_text(json.dumps(cache), encoding='utf-8')
    return cache


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources', type=Path, required=True)
    parser.add_argument('--places-dbf', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path(__file__).parent / 'output' / 'spatial')
    parser.add_argument('--census', action='store_true', help='Send address-only batches to the free Census service')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    rows = read_sources(args.sources, census_places(args.places_dbf))
    addresses, reasons = {}, Counter()
    for r in rows:
        for kind in ('origin', 'destination'):
            street, reason = address(r.get(kind + '_address'))
            bounds = re.match(r'^(\d+)\s*-\s*(\d+)\s+(.+)$', (r.get(kind + '_address') or '').upper())
            if reason == 'address_range' and bounds and int(bounds[2]) - int(bounds[1]) == 99:
                keys = []
                for number in (bounds[1], bounds[2]):
                    a = dict(street=number + ' ' + bounds[3], city=r.get(kind + '_city') or '', zip=r.get(kind + '_zip') or '')
                    if not (a['city'] or a['zip']):
                        break
                    key = hashlib.sha256(json.dumps(a, sort_keys=True).encode()).hexdigest()
                    addresses[key] = a
                    keys.append(key)
                if len(keys) == 2:
                    r[kind + '_range_keys'] = keys
                    r[kind + '_location_key'] = hashlib.sha256(':'.join(keys).encode()).hexdigest()
                    continue
            if not street:
                reasons[r['source'] + ':' + reason] += 1
                continue
            a = dict(street=street, city=r.get(kind + '_city') or '', zip=r.get(kind + '_zip') or '')
            if not (a['city'] or a['zip']):
                reasons[r['source'] + ':missing_locality'] += 1
                continue
            key = hashlib.sha256(json.dumps(a, sort_keys=True).encode()).hexdigest()
            addresses[key] = a
            r[kind + '_location_key'] = key
    cache = {}
    for file in args.output.glob('census-*.json'):
        cache.update(json.loads(file.read_text()))
    pending = sorted((k, v) for k, v in addresses.items() if k not in cache)
    print(json.dumps({'records': len(rows), 'unique_addresses': len(addresses), 'pending': len(pending), 'excluded_endpoints': reasons}), flush=True)
    if args.census:
        for start in range(0, len(pending), 500):
            batch = pending[start:start + 500]
            digest = hashlib.sha256(''.join(k for k, _ in batch).encode()).hexdigest()[:16]
            cache.update(geocode(batch, args.output / f'census-{digest}.json'))
            print(json.dumps({'processed': min(start + 500, len(pending)), 'total': len(pending)}), flush=True)
    coverage = defaultdict(Counter)
    for r in rows:
        for kind in ('origin', 'destination'):
            match = cache.get(r.get(kind + '_location_key'), {})
            if kind + '_range_keys' in r:
                ends = [cache.get(k, {}) for k in r[kind + '_range_keys']]
                if all('lat' in e for e in ends) and ends[0].get('matched_street') == ends[1].get('matched_street'):
                    dx = (ends[0]['lng'] - ends[1]['lng']) * 111195 * math.cos(math.radians(38))
                    dy = (ends[0]['lat'] - ends[1]['lat']) * 111195
                    if math.hypot(dx, dy) <= 1500:
                        match = dict(lat=sum(e['lat'] for e in ends)/2, lng=sum(e['lng'] for e in ends)/2,
                                     precision='census_address_range')
            coverage[r['source']]['endpoints'] += 1
            if 'lat' in match:
                r[kind + '_cell'] = cell(match['lat'], match['lng'])
                r[kind + '_precision'] = match['precision']
                # Count occupied 100 m subcells, not potentially duplicated address strings.
                subcell = (math.floor(math.radians(match['lng']) * 6371000 * math.cos(math.radians(38)) / 100),
                           math.floor(math.radians(match['lat']) * 6371000 / 100))
                r[kind + '_location_key'] = hashlib.sha256(str(subcell).encode()).hexdigest()
                coverage[r['source']]['geocoded'] += 1
                coverage[r['source']][match['precision']] += 1
    with (args.output / 'records.ndjson').open('w', encoding='utf-8') as stream:
        for r in rows:
            stream.write(json.dumps(r) + '\n')
    report = dict(unique_addresses=len(addresses), cached_addresses=len(cache),
                  matches=sum(v.get('status') == 'Match' for k, v in cache.items() if k in addresses),
                  coverage=coverage, excluded_endpoints=reasons)
    (args.output / 'coverage.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    write_import(rows, args.output / 'import-spatial.sql')
    print(json.dumps(report), flush=True)


def write_import(rows, target):
    entries = []
    for r in rows:
        for kind in ('origin', 'destination'):
            if kind + '_cell' in r:
                entries.append(dict(source=r['source'], source_row=r['source_row'], service_date=r['service_date'],
                    address=r[kind + '_address'], kind=kind + 's', cell_x=r[kind + '_cell'][0],
                    cell_y=r[kind + '_cell'][1], location_key=r[kind + '_location_key'], precision=r[kind + '_precision']))
    with target.open('w', encoding='utf-8') as stream:
        stream.write('BEGIN;\nSET LOCAL standard_conforming_strings = on;\nSELECT pg_advisory_xact_lock(7052025,7);\n')
        stream.write('CREATE TEMP TABLE spatial_stage (source text,source_row integer,service_date date,address text,kind text,cell_x integer,cell_y integer,location_key text,precision text) ON COMMIT DROP;\n')
        for start in range(0, len(entries), 1000):
            stream.write('INSERT INTO spatial_stage SELECT * FROM jsonb_populate_recordset(NULL::spatial_stage,' + literal(json.dumps(entries[start:start+1000])) + ');\n')
        stream.write('CREATE TEMP TABLE spatial_matched ON COMMIT DROP AS SELECT i.id AS import_id,s.source_row,s.kind,s.cell_x,s.cell_y,s.location_key,s.precision FROM spatial_stage s JOIN optimat.operation_imports i ON i.active AND i.source=s.source JOIN optimat.operation_trips t ON t.import_id=i.id AND t.source_row=s.source_row AND t.service_date=s.service_date AND s.address=CASE WHEN s.kind=\'origins\' THEN t.origin_address ELSE t.destination_address END;\n')
        stream.write(f"DO $$ BEGIN IF (SELECT count(*) FROM spatial_matched) <> {len(entries)} THEN RAISE EXCEPTION 'Spatial source reconciliation failed; no cells imported'; END IF; END $$;\n")
        stream.write('INSERT INTO optimat.operation_spatial_cells SELECT * FROM spatial_matched ON CONFLICT(import_id,source_row,kind) DO UPDATE SET cell_x=excluded.cell_x,cell_y=excluded.cell_y,location_key=excluded.location_key,precision=excluded.precision;\nCOMMIT;\n')


if __name__ == '__main__':
    main()
