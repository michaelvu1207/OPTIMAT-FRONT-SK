import MapView from './routes/MapView.svelte';
import ChatView from './routes/ChatView.svelte';
import BetaSignup from './routes/BetaSignup.svelte';
import TripPairs from './routes/TripPairs.svelte';
import ProvidersInfo from './routes/ProvidersInfo.svelte';
import ProviderPortal from './routes/ProviderPortal.svelte';
import ProviderPortalInfo from './routes/ProviderPortalInfo.svelte';
import ProviderPortalTripRecords from './routes/ProviderPortalTripRecords.svelte';
import ProviderPortalTripUpload from './routes/ProviderPortalTripUpload.svelte';
import ArchitectureDocs from './routes/ArchitectureDocs.svelte';
import DataApiDocs from './routes/DataApiDocs.svelte';
import UniversalServiceDashboard from './routes/UniversalServiceDashboard.svelte';
import WhatIsOptimat from './routes/WhatIsOptimat.svelte';

const routes = {
  // Chat interface (default)
  '/': ChatView,

  // Map interface
  '/map': MapView,

  // Paired trip records viewer
  '/trip-pairs': TripPairs,
  '/trip-records': TripPairs,

  // Chat interface with integrated examples
  '/chat': ChatView,

  // Providers info management page
  '/providers-info': ProvidersInfo,

  // Provider portal (login + provider-only tabs)
  '/provider-portal': ProviderPortal,
  '/provider-portal/info': ProviderPortalInfo,
  '/provider-portal/trip-records': ProviderPortalTripRecords,
  '/provider-portal/trip-upload': ProviderPortalTripUpload,
  '/staff': ProviderPortal,

  // Architecture documentation
  '/architecture': ArchitectureDocs,
  '/api-docs': DataApiDocs,
  '/universal-service-dashboard': UniversalServiceDashboard,
  '/what-is-optimat': WhatIsOptimat,

  // Beta signup page
  '/beta-signup': BetaSignup,

  // Catch-all route (redirects to map)
  '*': MapView
};

export default routes; 
