import unittest
from prepare_agencies import HEADERS, local_clock, normalize


class AgencyNormalizationTests(unittest.TestCase):
    places = {'PINOLE': (38, -122), 'HERCULES': (38.1, -122.1)}

    def event(self, activity, **changes):
        row = dict.fromkeys(HEADERS['WESTCAT'], '')
        row.update(BookingID='123', Ldate='20250701', ClientID='42', Activity=activity,
                   SchedStatus='Performed', Address='1 Test St', City='Pinole', ZipCode='94564',
                   ActArrTime='8:00', ActDepTime='8:01', SchedTime='8:00')
        row.update(changes)
        return row

    def test_westcat_events_join_by_booking_not_adjacency(self):
        raw = [(2, self.event('Drop', City='Hercules', ActArrTime='8:30')),
               (3, self.event('GarageLeave', BookingID='0')),
               (4, self.event('Pick')),
               (5, self.event('Pick', BookingID='124', SchedStatus='No-Show'))]
        rows, notes = normalize('WESTCAT', raw, self.places)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['source_row'], 4)
        self.assertEqual(rows[0]['destination_city'], 'HERCULES')
        self.assertEqual(rows[0]['dropoff_arrive_time'], '08:30:00')
        self.assertEqual(rows[1]['status'], 'No-Show')
        self.assertIsNone(rows[1]['destination_lat'])
        self.assertEqual(notes['pickup_only_bookings'], 1)
        self.assertEqual(notes['ignored_event_counts'], {'GarageLeave': 1})

    def test_inconsistent_event_identity_and_duplicates_fail(self):
        for raw in [[(2, self.event('Pick')), (3, self.event('Pick'))],
                    [(2, self.event('Pick')), (3, self.event('Drop', ClientID='other'))],
                    [(2, self.event('Drop'))]]:
            with self.assertRaises(ValueError):
                normalize('WESTCAT', raw, self.places)

    def test_different_endpoint_statuses_are_preserved(self):
        rows, _ = normalize('WESTCAT', [(2, self.event('Pick')), (3, self.event('Drop', SchedStatus='Scheduled'))], self.places)
        self.assertEqual(rows[0]['status'], 'Performed / Scheduled')

    def test_extended_times_are_missing_without_rollover(self):
        self.assertEqual(local_clock(' 7:31'), '07:31:00')
        for v in ('NULL', '#N/A', '', '24:19:00', '29:00:00'):
            self.assertIsNone(local_clock(v))
        with self.assertRaises(ValueError):
            local_clock('12:99')

    def test_tdt_booking_is_not_a_client_identifier(self):
        r = dict.fromkeys(HEADERS['TDT'], '')
        r.update(Date='07-01-2025', BookingId='123', Disposition='CA,UG',
                 **{'From City': 'Pinole', 'To City': 'Hercules', 'From': '1 Test', 'To': '2 Test'})
        rows, _ = normalize('TDT', [(2, r)], self.places)
        self.assertIsNone(rows[0]['client_id'])
        self.assertIsNone(rows[0]['origin_zip'])
        self.assertEqual(rows[0]['status'], 'CA,UG')
        with self.assertRaises(ValueError):
            normalize('TDT', [(2, r), (3, r)], self.places)

    def test_mm_multi_leg_ride_is_not_expanded_or_given_actual_times(self):
        r = dict.fromkeys(HEADERS['MM'], '')
        r.update({'Ride ID': '123', 'Ride Date': '7/1/25', 'Cancelled': 'NO', 'Confirmed': 'YES',
                  '# of Trips': '3', 'Pickup Time': '2:15', 'Appt Time': 'Open',
                  'Origin City': 'Pinole', 'Origin Zip': '94564', 'Destination City': 'Unknown'})
        rows, notes = normalize('MM', [(2, r)], self.places)
        self.assertEqual(len(rows), 1)
        self.assertEqual(notes['reported_trip_legs'], 3)
        self.assertIsNone(rows[0]['client_id'])
        self.assertIsNone(rows[0].get('pickup_depart_time'))
        self.assertIsNone(rows[0]['destination_lat'])


if __name__ == '__main__':
    unittest.main()
