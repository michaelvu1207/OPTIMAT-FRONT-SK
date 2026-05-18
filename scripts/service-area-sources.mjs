export const SERVICE_AREA_SOURCES = {
  'AC Transit': {
    type: 'remote_geojson',
    url: 'https://511.ccta.ca.gov/wp-content/themes/five11/js/data/ac.geojson',
  },
  BART: {
    type: 'remote_geojson',
    url: 'https://511.ccta.ca.gov/wp-content/themes/five11/js/data/bart.geojson',
  },
  'County Connection': {
    type: 'remote_geojson',
    url: 'https://511.ccta.ca.gov/wp-content/themes/five11/js/data/countyconnection.geojson',
  },
  'East Bay Paratransit': {
    type: 'local_geojson',
    path: 'ebp_service_area_export_wgs84.geojson',
  },
  'County Connection LINK': {
    type: 'local_geojson',
    path: 'Copy of link-paratransit.geojson',
  },
  'LINK Paratransit': {
    type: 'local_geojson',
    path: 'Copy of link-paratransit.geojson',
  },
  'One-Seat Regional Ride': {
    type: 'local_geojson',
    path: 'Copy of one-seat-regional-ride.geojson',
  },
  'San Ramon Go San Ramon': {
    type: 'local_geojson',
    path: 'Copy of go-san-ramon.geojson',
  },
  'Go San Ramon!': {
    type: 'local_geojson',
    path: 'Copy of go-san-ramon.geojson',
  },
  'Tri Delta Transit': {
    type: 'remote_geojson',
    url: 'https://511.ccta.ca.gov/wp-content/themes/five11/js/data/tdt.geojson',
  },
  WestCAT: {
    type: 'remote_geojson',
    url: 'https://511.ccta.ca.gov/wp-content/themes/five11/js/data/westcat.geojson',
  },
};

export function getServiceAreaSource(providerName) {
  return SERVICE_AREA_SOURCES[String(providerName ?? '').trim()] ?? null;
}
