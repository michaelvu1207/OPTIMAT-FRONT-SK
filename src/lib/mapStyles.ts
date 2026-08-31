export const NO_KEY_MAP_STYLES = [
  {
    id: 'standard',
    name: 'Standard',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
  },
  {
    id: 'humanitarian',
    name: 'Humanitarian',
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors, Tiles style by HOT',
  },
  {
    id: 'topographic',
    name: 'Topographic',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: 'Map data &copy; OpenStreetMap contributors, SRTM | Map style &copy; OpenTopoMap',
  },
] as const;

export const DEFAULT_MAP_STYLE = NO_KEY_MAP_STYLES[0];
