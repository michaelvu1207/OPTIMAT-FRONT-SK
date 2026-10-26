import unittest
from datetime import datetime, time
from prepare_link import address_key, clock, number, service_date, text, zip_code


class LinkNormalizationTests(unittest.TestCase):
    def test_identifiers_and_missing_values(self):
        self.assertEqual(text(1026.0), '1026')
        self.assertIsNone(text(None))
        self.assertEqual(zip_code(94549.0), '94549')
        self.assertEqual(address_key(' 100-199  Main St ', '94549'), ('100-199 MAIN ST', '94549'))
        self.assertIsNone(address_key(None, '94549'))
        with self.assertRaises(ValueError):
            zip_code('94549.9')

    def test_dates_and_times_preserve_local_wall_time(self):
        self.assertEqual(service_date(datetime(2025, 7, 1)), '2025-07-01')
        self.assertEqual(clock(time(8, 9, 10)), '08:09:10')
        self.assertEqual(clock('4:30 PM'), '16:30:00')
        self.assertEqual(clock(0.5), '12:00:00')
        self.assertIsNone(clock(None))
        with self.assertRaises(ValueError):
            clock('25:00')
        with self.assertRaises(ValueError):
            service_date('2025-02-30')

    def test_invalid_numbers_fail_instead_of_becoming_zero(self):
        self.assertEqual(number(0), 0)
        self.assertIsNone(number(None))
        for value in ('NaN', 'Infinity', -1):
            with self.assertRaises(ValueError):
                number(value)
        with self.assertRaises(ValueError):
            number(1.5, integer=True)


if __name__ == '__main__':
    unittest.main()
