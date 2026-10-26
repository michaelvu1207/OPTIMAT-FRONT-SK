"""Prepare the LINK workbook and an atomic PostgreSQL import. No network calls."""
import argparse
from collections import Counter, defaultdict
from datetime import date, datetime, time
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
import re
import struct

import openpyxl

VERSION = 'link-v1-city'
HEADERS = ['TripDate', 'ClientID', 'VehicleNumber', 'Passengers', 'PickUpAddress',
           'PickupCity', 'PickupZipCode', 'DropOffAddress', 'DropOffZipCode',
           'TripDuration', 'PickupArriveTime', 'PickupDepartTime', 'DropOffArriveTime',
           'DropOffDepartTime', 'OdometerDistance', 'SchTime', 'SpaceType', 'Status']


def text(value):
    if value is None or str(value).strip() == '':
        return None
    if isinstance(value, (int, float)) and float(value).is_integer():
        return str(int(value))
    return str(value).strip()


def city(value):
    value = text(value)
    return re.sub(r'\s+', ' ', value).upper() if value else None


def zip_code(value):
    value = text(value)
    if value is None:
        return None
    if not re.fullmatch(r'\d{5}(?:-\d{4})?', value):
        raise ValueError('Invalid ZIP code')
    return value


def address_key(address, zipcode):
    value = text(address)
    if not value or not zipcode:
        return None
    return (re.sub(r'\s+', ' ', value.upper()), zipcode)


def clock(value):
    if value is None or value == '':
        return None
    if isinstance(value, datetime):
        value = value.time()
    if isinstance(value, time):
        return value.replace(microsecond=0).isoformat()
    if isinstance(value, (int, float)) and 0 <= value < 1:
        seconds = min(86399, round(value * 86400))
        return f'{seconds // 3600:02d}:{seconds // 60 % 60:02d}:{seconds % 60:02d}'
    value = str(value).strip()
    for fmt in ('%H:%M:%S', '%H:%M', '%I:%M:%S %p', '%I:%M %p'):
        try:
            return datetime.strptime(value, fmt).strftime('%H:%M:%S')
        except ValueError:
            pass
    raise ValueError('Invalid local time')


def service_date(value):
    if isinstance(value, (date, datetime)):
        return value.strftime('%Y-%m-%d')
    for fmt in ('%m/%d/%Y', '%Y-%m-%d'):
        try:
            return datetime.strptime(str(value).strip(), fmt).strftime('%Y-%m-%d')
        except ValueError:
            pass
    raise ValueError('Invalid service date')


def number(value, integer=False):
    if value is None or value == '':
        return None
    try:
        n = Decimal(str(value))
    except InvalidOperation:
        raise ValueError('Invalid numeric value') from None
    if not n.is_finite() or n < 0 or (integer and n != int(n)):
        raise ValueError('Invalid nonnegative numeric value')
    return int(n) if integer else float(n)


def census_places(path):
    """Read the existing Census DBF without a GIS dependency."""
    places = defaultdict(list)
    with path.open('rb') as stream:
        header = stream.read(32)
        count, header_size, record_size = struct.unpack_from('<IHH', header, 4)
        fields = []
        while True:
            first = stream.read(1)
            if first == b'\r':
                break
            if not first:
                raise ValueError('Truncated DBF header')
            field = first + stream.read(31)
            fields.append((field[:11].split(b'\0')[0].decode('ascii'), field[16]))
        stream.seek(header_size)
        for _ in range(count):
            raw = stream.read(record_size)
            if len(raw) != record_size:
                raise ValueError('Truncated DBF record')
            if raw[:1] == b'*':
                continue
            offset, row = 1, {}
            for name, length in fields:
                row[name] = raw[offset:offset + length].decode('utf-8').strip()
                offset += length
            lat, lng = float(row['INTPTLAT']), float(row['INTPTLON'])
            if not (-90 <= lat <= 90 and -180 <= lng <= 180):
                raise ValueError('Invalid Census coordinate')
            places[city(row['NAME'])].append((lat, lng))
    return {name: values[0] for name, values in places.items() if len(values) == 1}


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def prepare(workbook, places_path, output, provider_id):
    file_hash = hashlib.sha256(workbook.read_bytes()).hexdigest()
    places_hash = hashlib.sha256(places_path.read_bytes()).hexdigest()
    import_id = hashlib.sha256(f'{VERSION}:{file_hash}:{places_hash}:{provider_id}'.encode()).hexdigest()
    places = census_places(places_path)
    wb = openpyxl.load_workbook(workbook, read_only=True, data_only=True)
    sheet = wb['in']
    iterator = sheet.iter_rows(values_only=True)
    headers = [str(v).strip() for v in next(iterator)]
    if headers != HEADERS:
        raise ValueError('LINK headers differ from the reviewed workbook; refusing a positional import')
    raw_rows = [(i, dict(zip(headers, values))) for i, values in enumerate(iterator, 2) if any(v is not None for v in values)]
    wb.close()
    address_cities = defaultdict(set)
    for _, row in raw_rows:
        key = address_key(row['PickUpAddress'], zip_code(row['PickupZipCode']))
        if key and city(row['PickupCity']):
            address_cities[key].add(city(row['PickupCity']))
    rows, issues = [], []
    for source_row, raw in raw_rows:
        try:
            origin_city = city(raw['PickupCity'])
            destination_key = address_key(raw['DropOffAddress'], zip_code(raw['DropOffZipCode']))
            candidates = address_cities.get(destination_key, set())
            destination_city = next(iter(candidates)) if len(candidates) == 1 else None
            origin_coords = places.get(origin_city, (None, None)) if text(raw['PickUpAddress']) else (None, None)
            destination_coords = places.get(destination_city, (None, None))
            row = dict(import_id=import_id, source_row=source_row, service_date=service_date(raw['TripDate']),
                       client_id=text(raw['ClientID']), passengers=number(raw['Passengers'], True),
                       status=text(raw['Status']), space_type=text(raw['SpaceType']),
                       origin_address=text(raw['PickUpAddress']), origin_city=origin_city, origin_zip=zip_code(raw['PickupZipCode']),
                       destination_address=text(raw['DropOffAddress']), destination_city=destination_city,
                       destination_zip=zip_code(raw['DropOffZipCode']),
                       destination_city_source='source_address_zip_match' if destination_city else 'unresolved',
                       pickup_arrive_time=clock(raw['PickupArriveTime']), pickup_depart_time=clock(raw['PickupDepartTime']),
                       dropoff_arrive_time=clock(raw['DropOffArriveTime']), dropoff_depart_time=clock(raw['DropOffDepartTime']),
                       scheduled_time=clock(raw['SchTime']), odometer_distance=number(raw['OdometerDistance']),
                       origin_lat=origin_coords[0], origin_lng=origin_coords[1],
                       destination_lat=destination_coords[0], destination_lng=destination_coords[1])
            rows.append(row)
        except ValueError as error:
            issues.append({'source_row': source_row, 'error': str(error)})
    output.mkdir(parents=True, exist_ok=True)
    if issues:
        (output / 'validation-errors.json').write_text(json.dumps(issues, indent=2), encoding='utf-8')
        raise ValueError(f'{len(issues)} invalid rows; see validation-errors.json. No import generated.')
    if not rows:
        raise ValueError('Workbook has no data rows')
    report = dict(source='LINK', provider_id=provider_id, import_id=import_id, filename=workbook.name,
                  file_sha256=file_hash, parser_version=VERSION, geographic_reference=places_path.name,
                  geographic_reference_sha256=places_hash, coordinate_precision='city_reference_point',
                  timezone='America/Los_Angeles', row_count=len(rows),
                  date_from=min(r['service_date'] for r in rows), date_to=max(r['service_date'] for r in rows),
                  status_counts=dict(Counter(r['status'] for r in rows)),
                  unique_clients=len({r['client_id'] for r in rows if r['client_id']}),
                  origin_mapped=sum(r['origin_lat'] is not None for r in rows),
                  destination_mapped=sum(r['destination_lat'] is not None for r in rows),
                  destination_city_matched=sum(r['destination_city'] is not None for r in rows),
                  missing_pickup_time=sum(r['pickup_depart_time'] is None for r in rows),
                  missing_dropoff_time=sum(r['dropoff_arrive_time'] is None for r in rows),
                  unresolved_origin_cities=sorted({r['origin_city'] for r in rows if r['origin_city'] and r['origin_lat'] is None}))
    (output / 'quality-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    with (output / 'link-records.ndjson').open('w', encoding='utf-8') as stream:
        for row in rows:
            stream.write(json.dumps(row, allow_nan=False) + '\n')
    # The entire import is atomic. Only one snapshot is active for this source/provider.
    with (output / 'import-link.sql').open('w', encoding='utf-8') as stream:
        stream.write("BEGIN;\nSET LOCAL standard_conforming_strings = on;\nSELECT pg_advisory_xact_lock(2006, 7052025);\n")
        stream.write(f"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM optimat.providers WHERE provider_id={provider_id} AND provider_name='LINK Paratransit') THEN RAISE EXCEPTION 'Expected LINK Paratransit provider mapping is missing'; END IF; END $$;\n")
        stream.write('INSERT INTO optimat.operation_imports (id,source,filename,file_sha256,parser_version,provider_id,row_count,date_from,date_to,quality_report) VALUES (' + ','.join([
            literal(import_id), "'LINK'", literal(workbook.name), literal(file_hash), literal(VERSION), str(provider_id), str(len(rows)), literal(report['date_from']), literal(report['date_to']), literal(json.dumps(report)) + '::jsonb']) + ') ON CONFLICT (id) DO NOTHING;\n')
        for start in range(0, len(rows), 500):
            payload = literal(json.dumps(rows[start:start + 500], allow_nan=False))
            stream.write(f'INSERT INTO optimat.operation_trips SELECT * FROM jsonb_populate_recordset(NULL::optimat.operation_trips, {payload}::jsonb) ON CONFLICT (import_id,source_row) DO NOTHING;\n')
        stream.write(f"DO $$ BEGIN IF (SELECT count(*) FROM optimat.operation_trips WHERE import_id={literal(import_id)}) <> {len(rows)} THEN RAISE EXCEPTION 'LINK row-count reconciliation failed'; END IF; END $$;\n")
        stream.write(f"UPDATE optimat.operation_imports SET active=false WHERE source='LINK' AND provider_id={provider_id} AND active AND id <> {literal(import_id)};\n")
        stream.write(f"UPDATE optimat.operation_imports SET active=true WHERE id={literal(import_id)};\nCOMMIT;\n")
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workbook', type=Path, required=True)
    parser.add_argument('--places-dbf', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path(__file__).parent / 'output')
    parser.add_argument('--provider-id', type=int, default=2006)
    args = parser.parse_args()
    if args.provider_id <= 0:
        parser.error('--provider-id must be positive')
    print(json.dumps(prepare(args.workbook, args.places_dbf, args.output, args.provider_id), indent=2))
