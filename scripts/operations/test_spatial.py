"""Synthetic tests only; no source data or network access."""
import unittest
from prepare_spatial import address, cell


class SpatialTests(unittest.TestCase):
    def test_alias_and_number_comma(self):
        self.assertEqual(address('Sample clinic:123, Main St'), ('123 MAIN ST', 'street_address'))

    def test_range_is_not_a_single_house(self):
        self.assertEqual(address('1200-1299 Main St'), (None, 'address_range'))

    def test_locality_and_empty_are_not_streets(self):
        self.assertIsNone(address('Concord')[0])
        self.assertIsNone(address(None)[0])

    def test_coarse_grid(self):
        self.assertEqual(cell(38, -122), cell(38.000001, -122.000001))
        self.assertNotEqual(cell(38, -122), cell(38.02, -122))


if __name__ == '__main__':
    unittest.main()
