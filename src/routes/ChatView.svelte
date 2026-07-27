<script>
  import { onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { derived } from 'svelte/store';
  import Chat from '../components/Chat.svelte';
  import ProviderResults from '../components/ProviderResults.svelte';
  import ProviderListPanel from '../components/ProviderListPanel.svelte';
  import { Map, TileLayer, Marker, GeoJSON, Polyline } from 'sveaflet';
  import { pingManager, PingTypes, pings, mapFocus } from '../lib/pingManager.js';
  import { serviceZoneManager, visibleServiceZones } from '../lib/serviceZoneManager.js';
  import { decodePolyline } from '../lib/utils/decodePolyline';
  import PageShell from '$lib/components/PageShell.svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Resizable from '$lib/components/ui/resizable/index.js';
  import {
    checkChatHealth,
    geocodeAddress as apiGeocodeAddress,
    listChatExamples,
    deleteChatExample,
    loadExampleReplayData,
    getConversationMessages,
    getConversationToolCalls,
    getProviderServiceZone
  } from '$lib/api';

  let mounted = false;
  let showChat = false;
  let showProviderResults = false;
  let providerData = null;
  let viewMode = 'chat'; // 'chat' or 'providers'
  let foundAddresses = [];
  let highlightedProviders = new Set();

  // Provider bar state
  let selectedProvider = null;
  let transitRouteCoordinates = [];
  let transitRouteSegments = [];

  const originPing = derived(pings, $pings => $pings.find(p => p.type === PingTypes.ORIGIN && p.visible));
  const destinationPing = derived(pings, $pings => $pings.find(p => p.type === PingTypes.DESTINATION && p.visible));
  const connectionLine = derived([originPing, destinationPing], ([$origin, $destination]) => {
    if ($origin && $destination) {
      return { coordinates: [$origin.coordinates, $destination.coordinates], show: true };
    }
    return { coordinates: [], show: false };
  });

  // Chat examples
  let chatExamples = [];
  let loadingExamples = false;
  let examplesError = null;
  let serverOnline = false;
  let chatComponent = null;
  let openDropdownId = null; // Track which example's dropdown is open
  let deletingExampleId = null; // Track which example is being deleted

  // Map configuration
  let mapCenter = [37.9020731, -122.0618702];
  let mapZoom = 12;
  let mapRenderNonce = 0;
  let lastFocusSignature = '';
  $: mapKey = `${currentMapStyleId}-${mapRenderNonce}`;

  const mapStyles = [
    { id: 'voyager', name: 'Voyager', url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap & CARTO' },
    { id: 'standard', name: 'Standard', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap' },
    { id: 'light', name: 'Light', url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap & CARTO' },
    { id: 'dark', name: 'Dark', url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap & CARTO' },
    { id: 'satellite', name: 'Satellite', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attribution: 'Tiles &copy; Esri' },
    { id: 'terrain', name: 'Terrain', url: 'https://stamen-tiles-{s}.a.ssl.fastly.net/terrain/{z}/{x}/{y}.png', attribution: 'Stamen / OpenStreetMap' }
  ];
  let currentMapStyleId = mapStyles[0].id;
  $: currentMapStyle = mapStyles.find((s) => s.id === currentMapStyleId) || mapStyles[0];

  $: if ($mapFocus.shouldFocus) {
    const focusSignature = JSON.stringify({
      center: $mapFocus.center,
      zoom: $mapFocus.zoom,
      focusId: $mapFocus.focusId
    });

    if (focusSignature !== lastFocusSignature) {
      lastFocusSignature = focusSignature;
      mapCenter = $mapFocus.center;
      mapZoom = $mapFocus.zoom;
      mapRenderNonce += 1;
      setTimeout(() => {
        pingManager.resetFocus();
        lastFocusSignature = '';
      }, 100);
    }
  }

  onMount(async () => {
    mounted = true;
    await checkServerHealth();
    if (serverOnline) {
      await loadChatExamples();
    }
    const savedStyleId = localStorage.getItem('optimat-map-style');
    const savedStyle = mapStyles.find((s) => s.id === savedStyleId);
    if (savedStyle) {
      currentMapStyleId = savedStyle.id;
    }
    setTimeout(() => {
      showChat = true;
    }, 300);
  });

  async function checkServerHealth() {
    try {
      serverOnline = await checkChatHealth();
      if (!serverOnline) examplesError = 'Chat server is currently offline.';
    } catch (e) {
      serverOnline = false;
      examplesError = 'Failed to connect to the chat server.';
    }
  }

  async function loadChatExamples() {
    loadingExamples = true;
    examplesError = null;
    try {
      const { data, error } = await listChatExamples();
      if (error) throw error;
      chatExamples = data || [];
    } catch (error) {
      examplesError = error.message;
      chatExamples = [];
    } finally {
      loadingExamples = false;
    }
  }

  async function deleteExample(exampleId, event) {
    event.stopPropagation(); // Prevent card click
    openDropdownId = null; // Close dropdown

    if (!confirm('Are you sure you want to delete this example?')) {
      return;
    }

    deletingExampleId = exampleId;
    try {
      const { error } = await deleteChatExample(exampleId);

      if (error) {
        throw error;
      }

      // Remove from local list
      chatExamples = chatExamples.filter(ex => ex.id !== exampleId);
    } catch (error) {
      console.error('Error deleting example:', error);
      alert(`Failed to delete example: ${error.message}`);
    } finally {
      deletingExampleId = null;
    }
  }

  function toggleDropdown(exampleId, event) {
    event.stopPropagation(); // Prevent card click
    openDropdownId = openDropdownId === exampleId ? null : exampleId;
  }

  // Close dropdown when clicking outside
  function handleClickOutside(event) {
    if (openDropdownId && !event.target.closest('.example-dropdown')) {
      openDropdownId = null;
    }
  }

  function changeMapStyle(id) {
    const style = mapStyles.find((s) => s.id === id);
    if (!style) return;
    currentMapStyleId = style.id;
    localStorage.setItem('optimat-map-style', style.id);
    mapRenderNonce += 1;
  }

  function safeParsePayload(value) {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  function normalizeProviderSearchPayload(rawPayload) {
    let payload = safeParsePayload(rawPayload);
    if (!payload || typeof payload !== 'object') return null;

    // Some callers pass the full attachment instead of attachment.data.
    if (payload.type === 'provider_search' && payload.data) {
      payload = safeParsePayload(payload.data);
    }

    if (!payload || typeof payload !== 'object') return null;

    let data = safeParsePayload(payload.data);
    let nested = null;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      nested = data;
      if (Array.isArray(data.data)) {
        data = data.data;
      }
    }

    const providers = Array.isArray(data)
      ? data
      : Array.isArray(payload.providers)
        ? payload.providers
        : [];

    return {
      ...(nested || {}),
      ...payload,
      data: providers,
      source_address: payload.source_address || nested?.source_address,
      destination_address: payload.destination_address || nested?.destination_address,
      origin: payload.origin || nested?.origin || null,
      destination: payload.destination || nested?.destination || null,
      public_transit: payload.public_transit || nested?.public_transit || null
    };
  }

  function hasPublicTransitResult(publicTransit) {
    if (!publicTransit) return false;
    if (typeof publicTransit === 'string') return publicTransit.trim().length > 0;
    if (typeof publicTransit !== 'object') return false;
    return Boolean(
      publicTransit.overview_polyline ||
      publicTransit.polyline ||
      publicTransit.journey_description ||
      publicTransit.summary ||
      publicTransit.duration_text ||
      (Array.isArray(publicTransit.steps) && publicTransit.steps.length > 0) ||
      (Array.isArray(publicTransit.routes) && publicTransit.routes.length > 0)
    );
  }

  function getProviderId(provider) {
    return provider?.is_public_transit ? 'public-transit' : provider?.provider_id || provider?.id;
  }

  function getTransitLines(publicTransit = providerData?.public_transit) {
    if (!publicTransit || typeof publicTransit !== 'object') return [];
    const lines = (Array.isArray(publicTransit.steps) ? publicTransit.steps : [])
      .map((step) => step?.transit_details?.line_name)
      .filter((line) => typeof line === 'string' && line.trim())
      .map((line) => line.trim());
    return [...new Set(lines)];
  }

  function getTransitSteps(publicTransit = providerData?.public_transit) {
    return Array.isArray(publicTransit?.steps) ? publicTransit.steps : [];
  }

  function getTransitRouteData(publicTransit) {
    if (!publicTransit || typeof publicTransit !== 'object') {
      return { coordinates: [], segments: [] };
    }

    const segments = getTransitSteps(publicTransit)
      .map((step, index) => {
        const coordinates = decodePolyline(step?.polyline || '');
        if (coordinates.length < 2) return null;
        const mode = String(step?.travel_mode || '').toUpperCase();
        const requestedColor = step?.transit_details?.line_color;
        const color = /^#[0-9a-f]{6}$/i.test(requestedColor || '') ? requestedColor : '#1a73e8';
        return {
          id: `transit-step-${index}`,
          coordinates,
          mode,
          color: mode === 'WALKING' ? '#64748b' : color,
          dashArray: mode === 'WALKING' ? '4, 7' : null
        };
      })
      .filter(Boolean);

    const overview = decodePolyline(publicTransit.overview_polyline || publicTransit.polyline || '');
    const coordinates = overview.length >= 2
      ? overview
      : segments.flatMap((segment, index) => index === 0 ? segment.coordinates : segment.coordinates.slice(1));

    return { coordinates, segments };
  }

  function focusOnTransitRoute(coordinates) {
    const validCoordinates = coordinates.filter((coordinate) =>
      Array.isArray(coordinate) && Number.isFinite(coordinate[0]) && Number.isFinite(coordinate[1])
    );
    if (validCoordinates.length < 2) {
      pingManager.focusOnAllPings();
      return;
    }

    const latitudes = validCoordinates.map((coordinate) => coordinate[0]);
    const longitudes = validCoordinates.map((coordinate) => coordinate[1]);
    const minLat = Math.min(...latitudes);
    const maxLat = Math.max(...latitudes);
    const minLng = Math.min(...longitudes);
    const maxLng = Math.max(...longitudes);
    const span = Math.max(maxLat - minLat, maxLng - minLng, 0.002);

    mapCenter = [(minLat + maxLat) / 2, (minLng + maxLng) / 2];
    mapZoom = Math.max(8, Math.min(16, Math.floor(Math.log2(360 / span))));
    mapRenderNonce += 1;
  }

  function clearTransitRoute() {
    transitRouteCoordinates = [];
    transitRouteSegments = [];
  }

  async function geocodeAddress(address) {
    try {
      const data = await apiGeocodeAddress(address);
      if (data.success && data.coordinates) {
        const { longitude, latitude } = data.coordinates;
        return [latitude, longitude];
      }
      return null;
    } catch (err) {
      return null;
    }
  }

  async function handleAddressFound(event) {
    const { address, messageRole, placeName } = event.detail;
    const coordinates = await geocodeAddress(address);
    if (!coordinates) return;

    foundAddresses.push({ address, coordinates, role: messageRole, placeName });

    if (messageRole === 'attachment_click') {
      const label = placeName || address;
      const description = placeName ? `${placeName}\n${address}` : address;
      pingManager.addPing({
        type: PingTypes.SEARCH_RESULT,
        coordinates,
        label,
        description,
        metadata: { source: 'address_attachment', address, placeName }
      }, false);
      pingManager.focusOnAllPings();
      if (viewMode === 'providers') {
        viewMode = 'chat';
        showProviderResults = false;
      }
      return;
    }

    if (foundAddresses.length === 1) {
      pingManager.addPing({
        type: PingTypes.ORIGIN,
        coordinates,
        label: placeName || 'Origin',
        description: address,
        metadata: { source: 'system_geocode', address, placeName }
      }, false);
      pingManager.focusOnAllPings();
    } else {
      const isDestination = foundAddresses.length >= 2;
      pingManager.removePingsByType(PingTypes.DESTINATION);
      pingManager.addPing({
        type: PingTypes.DESTINATION,
        coordinates,
        label: placeName || (isDestination ? 'Destination' : 'Address'),
        description: address,
        metadata: { source: 'system_geocode', address, placeName }
      }, false);
      pingManager.focusOnAllPings();
    }
  }

  async function handleProvidersFound(event) {
    providerData = normalizeProviderSearchPayload(event.detail);
    showProviderResults = true;
    viewMode = 'providers';
    selectedProvider = null;
    clearTransitRoute();
    if (providerData?.data && Array.isArray(providerData.data)) {
      highlightedProviders = new Set(providerData.data.map((p) => p.provider_id));
    }
    if (chatComponent) {
      chatComponent.pauseExamplePlayback?.();
    }
    serviceZoneManager.clearAllServiceZones();
    pingManager.removePingsByType(PingTypes.SEARCH_RESULT);
    pingManager.removePingsByType(PingTypes.ORIGIN);
    pingManager.removePingsByType(PingTypes.DESTINATION);
    // Create pings if we have coordinates or addresses
    if ((providerData?.origin && providerData?.destination) ||
        (providerData?.source_address || providerData?.destination_address)) {
      await createProviderSearchPings();
    }
  }

  async function createProviderSearchPings() {
    if (!providerData) return;

    const pingsToAdd = [];

    // Use pre-geocoded origin coordinates if available (from FASTAPI response)
    if (providerData.origin?.lat && providerData.origin?.lon) {
      pingsToAdd.push({
        type: PingTypes.ORIGIN,
        coordinates: [providerData.origin.lat, providerData.origin.lon],
        label: 'Origin',
        description: providerData.source_address || 'Origin',
        metadata: { source: 'provider_search', address: providerData.source_address }
      });
    } else if (providerData.source_address) {
      // Fallback: geocode if coordinates not provided
      const originCoords = await geocodeAddress(providerData.source_address);
      if (originCoords) {
        pingsToAdd.push({
          type: PingTypes.ORIGIN,
          coordinates: originCoords,
          label: 'Origin',
          description: providerData.source_address,
          metadata: { source: 'provider_search', address: providerData.source_address }
        });
      }
    }

    // Use pre-geocoded destination coordinates if available (from FASTAPI response)
    if (providerData.destination?.lat && providerData.destination?.lon) {
      pingsToAdd.push({
        type: PingTypes.DESTINATION,
        coordinates: [providerData.destination.lat, providerData.destination.lon],
        label: 'Destination',
        description: providerData.destination_address || 'Destination',
        metadata: { source: 'provider_search', address: providerData.destination_address }
      });
    } else if (providerData.destination_address) {
      // Fallback: geocode if coordinates not provided
      const destCoords = await geocodeAddress(providerData.destination_address);
      if (destCoords) {
        pingsToAdd.push({
          type: PingTypes.DESTINATION,
          coordinates: destCoords,
          label: 'Destination',
          description: providerData.destination_address,
          metadata: { source: 'provider_search', address: providerData.destination_address }
        });
      }
    }

    if (pingsToAdd.length > 0) {
      pingManager.addPings(pingsToAdd, true);  // true to focus map on pings
    }
  }

  function handleCloseProviderResults() {
    showProviderResults = false;
    viewMode = 'chat';
    highlightedProviders = new Set();
    serviceZoneManager.clearAllServiceZones();
    selectedProvider = null;
    clearTransitRoute();
    pingManager.removePingsByType(PingTypes.ORIGIN);
    pingManager.removePingsByType(PingTypes.DESTINATION);
    chatComponent?.resumeExamplePlayback?.();
  }

  function backToChat() {
    viewMode = 'chat';
    showProviderResults = false;
    highlightedProviders = new Set();
    serviceZoneManager.clearAllServiceZones();
    selectedProvider = null;
    clearTransitRoute();
    pingManager.removePingsByType(PingTypes.ORIGIN);
    pingManager.removePingsByType(PingTypes.DESTINATION);
    chatComponent?.resumeExamplePlayback?.();
  }

  function handleNewConversationStarted() {
    pingManager.clearAllPings();
    highlightedProviders = new Set();
    serviceZoneManager.clearAllServiceZones();
    selectedProvider = null;
    clearTransitRoute();
    showProviderResults = false;
    viewMode = 'chat';
  }

  async function handleExampleSaved() {
    // Refresh examples list so newly saved examples show up immediately.
    await loadChatExamples();
  }

  async function viewChatExample(example) {
    try {
      pingManager.clearAllPings();

      // Try new replay endpoint first
      const { data: replayData, error: replayError } = await loadExampleReplayData(example.conversation_id);

      if (!replayError && replayData) {
        // Use new replay endpoint
        console.log('Using new replay endpoint:', replayData);

        // Add example metadata to replay data
        replayData.example = example;

        // Use the new loadExampleReplay function
        await chatComponent?.loadExampleReplay?.(replayData);
      } else {
        // Fallback to legacy approach if replay endpoint not available
        console.log('Replay endpoint not available, falling back to legacy approach');
        const [messagesResult, toolCallsResult] = await Promise.all([
          getConversationMessages(example.conversation_id),
          getConversationToolCalls(example.conversation_id)
        ]);
        if (messagesResult.error) throw new Error(`Failed to load conversation: ${messagesResult.error.message}`);
        if (toolCallsResult.error) throw new Error(`Failed to load tool calls: ${toolCallsResult.error.message}`);
        const conversationStates = buildConversationStates(
          messagesResult.data?.messages || [],
          toolCallsResult.data?.tool_calls || []
        );
        await chatComponent?.loadExampleWithStates?.(conversationStates, example);
      }
    } catch (error) {
      examplesError = `Failed to load example: ${error.message}`;
    }
  }

  // Provider bar helper functions
  function selectProvider(provider) {
    const providerId = getProviderId(provider);
    const selectedId = getProviderId(selectedProvider);

    // Toggle selection - click again to deselect
    if (selectedId === providerId) {
      selectedProvider = null;
      serviceZoneManager.clearAllServiceZones();
      clearTransitRoute();
      pingManager.focusOnAllPings();
    } else {
      selectedProvider = provider;
      showProviderZoneOnMap(provider);
    }
  }

  async function showProviderZoneOnMap(provider) {
    if (!provider) return;
    const providerId = getProviderId(provider);
    serviceZoneManager.clearAllServiceZones();
    clearTransitRoute();

    if (provider.is_public_transit) {
      const route = getTransitRouteData(provider.public_transit);
      transitRouteCoordinates = route.coordinates;
      transitRouteSegments = route.segments;
      focusOnTransitRoute(route.coordinates);
      return;
    }

    let serviceZone = provider.service_zone;
    if (!serviceZone && providerId != null) {
      try {
        const { data, error } = await getProviderServiceZone(providerId);
        if (!error && data?.has_service_zone && data.raw_data) {
          serviceZone = data.raw_data;
          provider.service_zone = serviceZone;
        }
      } catch (e) {
        console.error('Error fetching provider service zone:', e);
      }
    }

    if (serviceZone) {
      try {
        const geoJson = typeof serviceZone === 'string'
          ? JSON.parse(serviceZone)
          : serviceZone;

        serviceZoneManager.addServiceZone({
          type: 'provider',
          geoJson: geoJson,
          label: provider.provider_name,
          description: `${provider.provider_name} service area`,
          metadata: { providerId: providerId, provider: provider },
          config: { color: '#8b5cf6', fillOpacity: 0.15 }
        }, true);
      } catch (e) {
        console.error('Error parsing provider service zone:', e);
      }
    }
  }

  function formatEligibility(eligibilityReqs) {
    if (!eligibilityReqs) return null;

    // Handle JSON object format
    let reqs = eligibilityReqs;
    if (typeof eligibilityReqs === 'string') {
      try {
        reqs = JSON.parse(eligibilityReqs);
      } catch {
        return eligibilityReqs; // Return as-is if not valid JSON
      }
    }

    // Extract from object wrapper if needed
    if (reqs && typeof reqs === 'object' && !Array.isArray(reqs)) {
      const eligibility = typeof reqs.eligibility === 'string'
        ? reqs.eligibility.trim()
        : typeof reqs.eligibility_text === 'string'
          ? reqs.eligibility_text.trim()
          : '';
      const proof = typeof reqs.proof === 'string'
        ? reqs.proof.trim()
        : typeof reqs.proof_process === 'string'
          ? reqs.proof_process.trim()
          : '';

      if (eligibility || proof) {
        return [
          eligibility ? `Eligibility: ${eligibility}` : null,
          proof ? `Proof: ${proof}` : null
        ].filter(Boolean).join(' · ');
      }

      if (reqs.eligibility_reqs) {
        reqs = reqs.eligibility_reqs;
      }
    }

    if (!Array.isArray(reqs) || reqs.length === 0) return null;

    // Extract eligibility_req values
    const eligList = reqs.map(r => {
      if (typeof r === 'string') return r;
      const type = r?.eligibility_req || r?.eligibility_type || r?.type || '';
      const proof = r?.proof || r?.proof_process || '';
      if (type && proof) return `${type} (${proof})`;
      return type;
    }).filter(Boolean);

    return eligList.length > 0 ? eligList.join(', ') : null;
  }

  function formatMetadataValue(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (Array.isArray(value)) {
      const compact = value
        .map((item) => typeof item === 'object' ? JSON.stringify(item) : String(item))
        .filter(Boolean);
      return compact.length ? compact.join(', ') : null;
    }
    if (typeof value === 'object') {
      const type = value.type || value.method || value.advance_notice || value.advanceNotice;
      if (type) {
        return [type, value.advance_notice || value.advanceNotice].filter(Boolean).join(' · ');
      }
      return JSON.stringify(value);
    }
    return String(value);
  }

  function titleizeKey(key) {
    return key
      .replace(/^provider_/, '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function getProviderMetadataRows(provider) {
    const keys = [
      'provider_org',
      'eligibility_reqs',
      'routing_type',
      'planning_type',
      'schedule_type',
      'booking',
      'fare',
      'service_area_cities',
      'service_area_source',
      'service_area_notes',
      'provider_software',
      'round_trip_booking',
      'investigated'
    ];

    return keys
      .map((key) => ({
        label: key === 'eligibility_reqs' ? 'Eligibility Requirements' : titleizeKey(key),
        value: key === 'eligibility_reqs'
          ? formatEligibility(provider?.eligibility_reqs)
          : formatMetadataValue(provider?.[key])
      }))
      .filter((row) => row.value);
  }

  function getProviderMatchCriteria(provider) {
    const criteria = provider?.match_criteria;
    const passed = Array.isArray(criteria?.passed) ? criteria.passed : [];
    if (passed.length > 0) {
      return passed.map((item) => {
        if (typeof item === 'string') return item;
        const label = item?.label || 'Matched criterion';
        const detail = item?.detail ? `: ${item.detail}` : '';
        return `${label}${detail}`;
      });
    }

    const fallback = [];
    if (providerData?.source_address || providerData?.origin || providerData?.source_coordinates) {
      fallback.push(`Origin is inside this provider's service area`);
    }
    if (providerData?.destination_address || providerData?.destination || providerData?.destination_coordinates) {
      fallback.push(`Destination is inside this provider's service area`);
    }
    if (providerData?.filtered_out_count !== undefined) {
      fallback.push('Service-hour filter was applied before returning this provider');
    }
    fallback.push('Eligibility was not hard-filtered; it is shown for recommendation reasoning');
    return fallback;
  }

  function getFilterAlgorithmText(provider) {
    return provider?.match_criteria?.algorithm ||
      providerData?.filter_algorithm ||
      'The search geocodes the trip, checks provider service areas against the trip points, applies structured filters such as service hours or provider type when available, and leaves eligibility for the chatbot to reason over from the displayed text.';
  }

  function formatServiceHours(serviceHours) {
    if (!serviceHours) return null;

    let hours = serviceHours;
    if (typeof serviceHours === 'string') {
      try {
        hours = JSON.parse(serviceHours);
      } catch {
        return serviceHours;
      }
    }

    // Extract hours array from object wrapper
    if (hours?.hours) {
      hours = hours.hours;
    }

    if (!Array.isArray(hours) || hours.length === 0) return null;

    // Format time from "0500" to "5:00 AM"
    const formatTime = (time) => {
      if (!time) return '';
      const h = parseInt(time.substring(0, 2));
      const m = time.substring(2);
      const period = h >= 12 ? 'PM' : 'AM';
      const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return m === '00' ? `${hour12}${period}` : `${hour12}:${m}${period}`;
    };

    // Format day pattern to readable string
    const formatDays = (dayPattern) => {
      if (!dayPattern) return '';
      // Pattern: Mon Tue Wed Thu Fri Sat Sun
      const days = ['M', 'Tu', 'W', 'Th', 'F', 'Sa', 'Su'];
      const activeDays = [];
      for (let i = 0; i < dayPattern.length && i < 7; i++) {
        if (dayPattern[i] === '1') activeDays.push(days[i]);
      }
      // Simplify common patterns
      if (activeDays.join('') === 'MTuWThF') return 'M-F';
      if (activeDays.join('') === 'SaSu') return 'Sat-Sun';
      if (activeDays.length === 1) return activeDays[0];
      return activeDays.join('/');
    };

    // Group and format hours
    const formatted = hours.slice(0, 2).map(h => {
      const days = formatDays(h.day);
      const start = formatTime(h.start);
      const end = formatTime(h.end);
      return `${days} ${start}-${end}`;
    });

    return formatted.join(', ');
  }

  function pickFirstNonEmptyString(...values) {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  }

  function parseObject(value) {
    if (!value || typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  function getProviderEmail(provider) {
    const contacts = parseObject(provider?.contacts);
    if (!Array.isArray(contacts)) return null;
    return contacts.map((contact) => contact?.email).find((email) => typeof email === 'string' && email.includes('@')) || null;
  }

  function normalizeScheduleType(scheduleTypeValue) {
    if (!scheduleTypeValue) return null;

    let scheduleType = scheduleTypeValue;
    if (typeof scheduleType === 'string') {
      try {
        scheduleType = JSON.parse(scheduleType);
      } catch {
        return { type: scheduleType, advance_notice: null };
      }
    }

    if (!scheduleType || typeof scheduleType !== 'object') return null;

    const nested =
      scheduleType.schedule_type && typeof scheduleType.schedule_type === 'object'
        ? scheduleType.schedule_type
        : null;

    const type = pickFirstNonEmptyString(
      scheduleType.type,
      scheduleType.schedule_type,
      scheduleType.scheduleType,
      nested?.type,
      nested?.schedule_type,
      nested?.scheduleType
    );

    const advance_notice = pickFirstNonEmptyString(
      scheduleType.advance_notice,
      scheduleType.advanceNotice,
      nested?.advance_notice,
      nested?.advanceNotice
    );

    return { type, advance_notice };
  }

  function formatAdvanceNotice(advanceNotice) {
    if (!advanceNotice) return null;

    const raw = String(advanceNotice).trim();
    if (!raw) return null;

    const normalized = raw.toLowerCase().replace(/\s+/g, '');

    const rangeMatch = normalized.match(/^(\d+)-(\d+)([a-z]+)$/);
    if (rangeMatch) {
      const [, startRaw, endRaw, unitRaw] = rangeMatch;
      const start = parseInt(startRaw, 10);
      const end = parseInt(endRaw, 10);
      const unit = unitRaw;
      const unitLabel = normalizeAdvanceNoticeUnit(unit, Math.max(start, end));
      if (unitLabel) return `${start}–${end} ${unitLabel}`;
      return raw;
    }

    const match = normalized.match(/^(\d+)([a-z]+)$/);
    if (!match) return raw;

    const [, amountRaw, unitRaw] = match;
    const amount = parseInt(amountRaw, 10);
    if (Number.isNaN(amount)) return raw;

    const unitLabel = normalizeAdvanceNoticeUnit(unitRaw, amount);
    if (!unitLabel) return raw;

    return `${amount} ${unitLabel}`;
  }

  function normalizeAdvanceNoticeUnit(unit, amount) {
    const singular = amount === 1;

    if (unit === 'd' || unit === 'day' || unit === 'days') return singular ? 'day' : 'days';
    if (unit === 'h' || unit === 'hr' || unit === 'hrs' || unit === 'hour' || unit === 'hours') return singular ? 'hour' : 'hours';
    if (unit === 'm' || unit === 'min' || unit === 'mins' || unit === 'minute' || unit === 'minutes') return singular ? 'minute' : 'minutes';
    if (unit === 'w' || unit === 'wk' || unit === 'wks' || unit === 'week' || unit === 'weeks') return singular ? 'week' : 'weeks';

    return null;
  }

  function getBookingNotice(provider) {
    const meta = normalizeScheduleType(provider?.schedule_type);
    if (!meta?.type) return null;

    if (meta.type === 'in-advance-book') {
      const notice = formatAdvanceNotice(meta.advance_notice);
      return notice ? `Book ${notice} in advance` : 'Book in advance';
    }

    if (meta.type === 'real-time-book') return 'Book in real time';
    if (meta.type === 'fixed-schedules') return 'Fixed schedules';

    return null;
  }

  function buildConversationStates(messages, toolCalls) {
    const states = [];
    let currentProviders = null;
    const sortedMessages = (messages || [])
      .filter((msg) => msg.role !== 'system' && msg.created_at)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    if (toolCalls.find_providers?.length > 0) {
      const providerCall = toolCalls.find_providers[0];
      if (providerCall.provider_data) {
        currentProviders = {
          data: providerCall.provider_data,
          source_address: providerCall.source_address,
          destination_address: providerCall.destination_address
        };
      }
    }

    let providersAlreadyShown = false;
    for (const message of sortedMessages) {
      const isProviderMessage = message.role === 'ai' && currentProviders && (
        message.content?.includes('found a provider') ||
        message.content?.includes('found providers') ||
        message.content?.includes('Trip Details')
      );
      const shouldShowProviders = isProviderMessage && !providersAlreadyShown;
      if (shouldShowProviders) providersAlreadyShown = true;
      states.push({
        message,
        state: {
          providers: shouldShowProviders ? currentProviders : null,
          hasProviders: shouldShowProviders
        }
      });
    }
    return states;
  }
</script>

{#if mounted}
  <PageShell
    title="AI Chat Assistant"
    description="Converse with the assistant and review providers"
    appMode={true}
  >
    <!-- Main horizontal layout: Left (Map + Results) | Right (Chat full height) -->
    <Resizable.PaneGroup direction="horizontal" class="flex-1 h-full">
      <!-- Left: Nested vertical panels (Map top, Results bottom) -->
      <Resizable.Pane defaultSize={60} minSize={35} class="relative">
        <Resizable.PaneGroup direction="vertical" class="h-full">
          <!-- Top: Map Panel -->
          <Resizable.Pane defaultSize={providerData ? 60 : 70} minSize={40} class="relative">
            <!-- Map style selector - floating overlay -->
            <div class="absolute top-2 left-2 z-10 rounded-md border border-border/50 bg-background/95 backdrop-blur px-2 py-1.5 shadow-sm">
              <select
                class="bg-transparent text-xs border-0 focus:ring-0 cursor-pointer"
                bind:value={currentMapStyleId}
                on:change={(e) => changeMapStyle(e.target.value)}
              >
                {#each mapStyles as style}
                  <option value={style.id}>{style.name}</option>
                {/each}
              </select>
            </div>

            {#if transitRouteCoordinates.length > 1 && selectedProvider?.is_public_transit}
              <div
                class="absolute right-2 top-2 z-10 max-w-56 rounded-lg border border-blue-200 bg-background/95 px-3 py-2 shadow-md backdrop-blur"
                data-testid="transit-route-summary"
              >
                <div class="flex items-center gap-2 text-xs font-semibold text-foreground">
                  <span class="h-2.5 w-2.5 rounded-full bg-[#1a73e8]"></span>
                  Public Transit Route
                </div>
                <div class="mt-1 text-[11px] text-muted-foreground">
                  {[providerData?.public_transit?.duration_text, providerData?.public_transit?.distance_text].filter(Boolean).join(' · ')}
                </div>
                {#if getTransitLines().length > 0}
                  <div class="mt-1 text-[10px] text-blue-700">{getTransitLines().join(' → ')}</div>
                {/if}
              </div>
            {/if}

            <div class="absolute inset-0" in:fade={{ duration: 400 }}>
              {#key mapKey}
                <Map options={{ center: mapCenter, zoom: mapZoom }}>
                  <TileLayer url={currentMapStyle.url} options={{ attribution: currentMapStyle.attribution, maxZoom: 19 }} />

                  {#each $visibleServiceZones as zone (zone.id)}
                    {#if zone.geoJson}
                      <GeoJSON
                        json={zone.geoJson}
                        options={{
                          style: () => zone.config,
                          onEachFeature: (feature, layer) => {
                            layer.on({
                              mouseover: (e) => {
                                const layer = e.target;
                                layer.setStyle({
                                  weight: zone.config.weight + 1,
                                  opacity: Math.min(zone.config.opacity + 0.2, 1),
                                  fillOpacity: Math.min(zone.config.fillOpacity + 0.2, 0.6)
                                });
                                layer.bringToFront();
                              },
                              mouseout: (e) => {
                                const layer = e.target;
                                layer.setStyle(zone.config);
                              },
                              click: () => serviceZoneManager.focusOnServiceZone(zone.id)
                            });
                            const popupContent = `
                              <div class="service-zone-popup">
                                <div class="zone-popup-header">
                                  <strong>${zone.label}</strong>
                                  <span class="zone-type">${zone.type}</span>
                                </div>
                                ${zone.description ? `<div class="zone-popup-description">${zone.description}</div>` : ''}
                                ${zone.metadata?.provider?.provider_org ? `<div class="zone-popup-org">🏢 ${zone.metadata.provider.provider_org}</div>` : ''}
                                ${zone.metadata?.provider?.eligibility_req ? `<div class="zone-popup-eligibility">📋 ${zone.metadata.provider.eligibility_req}</div>` : ''}
                              </div>
                            `;
                            layer.bindPopup(popupContent);
                          }
                        }}
                      />
                    {/if}
                  {/each}

                  {#if transitRouteCoordinates.length > 1}
                    <Polyline
                      latLngs={transitRouteCoordinates}
                      options={{
                        color: '#ffffff',
                        weight: 10,
                        opacity: 0.95,
                        lineCap: 'round',
                        lineJoin: 'round',
                        className: 'public-transit-route-casing'
                      }}
                    />
                    <Polyline
                      latLngs={transitRouteCoordinates}
                      options={{
                        color: '#1a73e8',
                        weight: transitRouteSegments.length > 0 ? 4 : 6,
                        opacity: transitRouteSegments.length > 0 ? 0.32 : 0.95,
                        lineCap: 'round',
                        lineJoin: 'round',
                        className: 'public-transit-route'
                      }}
                    />
                    {#each transitRouteSegments as segment (segment.id)}
                      <Polyline
                        latLngs={segment.coordinates}
                        options={{
                          color: segment.color,
                          weight: segment.mode === 'WALKING' ? 5 : 6,
                          opacity: 0.95,
                          dashArray: segment.dashArray,
                          lineCap: 'round',
                          lineJoin: 'round',
                          className: `public-transit-segment public-transit-segment-${segment.mode.toLowerCase()}`
                        }}
                      />
                    {/each}
                  {/if}

                  {#if $connectionLine.show && transitRouteCoordinates.length === 0}
                    <Polyline
                      latLngs={$connectionLine.coordinates}
                      options={{ color: '#6366f1', weight: 3, opacity: 0.8, dashArray: '10, 5' }}
                    />
                  {/if}

                  {#each $pings.filter((ping) => ping.visible) as ping (ping.id)}
                    <Marker
                      latLng={ping.coordinates}
                      popup={`<div class="ping-popup"><div class="ping-popup-header"><strong>${ping.type === PingTypes.ORIGIN ? '🚀 Origin' : ping.type === PingTypes.DESTINATION ? '🎯 Destination' : `${ping.config.icon} ${ping.label}`}</strong></div><div class="ping-popup-content">${ping.description || ping.label}</div></div>`}
                      options={{ className: `ping-marker-${ping.type} animated-marker` }}
                    />
                  {/each}
                </Map>
              {/key}
            </div>
          </Resizable.Pane>

          <Resizable.Handle withHandle />

          <!-- Bottom: Examples -->
          <Resizable.Pane defaultSize={30} minSize={20} class="flex flex-col overflow-hidden bg-card border-t border-border/40">
            <div class="flex-shrink-0 border-b border-border/40 px-3 py-2 bg-muted/30">
              <span class="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                💡 Examples
              </span>
            </div>
            <div class="flex-1 overflow-y-auto p-3">
              {#if loadingExamples}
                <div class="flex items-center justify-center h-full">
                  <div class="text-sm text-muted-foreground">Loading examples...</div>
                </div>
              {:else if examplesError}
                <div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {examplesError}
                </div>
              {:else if chatExamples.length === 0}
                <div class="flex items-center justify-center h-full">
                  <div class="text-sm text-muted-foreground">No examples available</div>
                </div>
              {:else}
                <!-- svelte-ignore a11y-click-events-have-key-events -->
                <!-- svelte-ignore a11y-no-static-element-interactions -->
                <!-- Horizontal scrolling card container -->
                <div
                  class="flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent"
                  on:click={handleClickOutside}
                >
                  {#each chatExamples as example, index}
                    <div class="relative flex-shrink-0 w-48 snap-start">
                      <!-- Three dots menu button -->
                      <div class="example-dropdown absolute top-2 right-2 z-10">
                        <button
                          class="p-1 rounded-md hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-colors"
                          on:click={(e) => toggleDropdown(example.id, e)}
                          aria-label="Example options"
                        >
                          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
                          </svg>
                        </button>

                        <!-- Dropdown menu -->
                        {#if openDropdownId === example.id}
                          <div
                            class="absolute right-0 top-full mt-1 w-32 rounded-md border border-border bg-popover shadow-lg z-20"
                            transition:fade={{ duration: 100 }}
                          >
                            <button
                              class="w-full px-3 py-2 text-left text-xs text-destructive hover:bg-destructive/10 rounded-md flex items-center gap-2 transition-colors"
                              on:click={(e) => deleteExample(example.id, e)}
                              disabled={deletingExampleId === example.id}
                            >
                              {#if deletingExampleId === example.id}
                                <svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                                <span>Deleting...</span>
                              {:else}
                                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                                <span>Delete</span>
                              {/if}
                            </button>
                          </div>
                        {/if}
                      </div>

                      <!-- Card button -->
                      <button
                        class="w-full h-full rounded-xl border border-border/70 bg-gradient-to-br from-card to-muted/30 p-4 pt-8 text-left shadow-sm transition-all hover:shadow-md hover:border-primary/60 hover:scale-[1.02]"
                        on:click={() => viewChatExample(example)}
                      >
                        <!-- Category badge -->
                        {#if example.category}
                          <div class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-primary/10 text-primary mb-2">
                            {example.category}
                          </div>
                        {:else}
                          <div class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground mb-2">
                            Example {index + 1}
                          </div>
                        {/if}

                        <!-- Title -->
                        <div class="text-sm font-semibold text-foreground mb-1.5 line-clamp-2 leading-tight">
                          {example.title || 'Untitled Example'}
                        </div>

                        <!-- Description -->
                        {#if example.description}
                          <div class="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                            {example.description}
                          </div>
                        {/if}

                        <!-- Play indicator -->
                        <div class="mt-3 flex items-center gap-1.5 text-[10px] text-primary/70">
                          <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" />
                          </svg>
                          <span>Click to play</span>
                        </div>
                      </button>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </Resizable.Pane>
        </Resizable.PaneGroup>
      </Resizable.Pane>

      <Resizable.Handle withHandle />

      <!-- Right: Chat Panel (full height) -->
      <Resizable.Pane defaultSize={40} minSize={25} class="bg-card border-l border-border/40 flex flex-col overflow-hidden">
        <!-- Chat Header -->
        <div class="flex-shrink-0 border-b border-border/40 px-3 py-2 bg-muted/30">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-muted-foreground uppercase tracking-wide">💬 Chat</span>
            {#if !serverOnline}
              <span class="text-[10px] text-destructive">Offline</span>
            {/if}
          </div>
        </div>
        <!-- Chat Content -->
        <div class="flex-1 min-h-0 overflow-hidden">
          <Chat
            bind:this={chatComponent}
            onProvidersFound={handleProvidersFound}
            onProviderSelect={selectProvider}
            mapSelectedProvider={selectedProvider}
            on:addressFound={handleAddressFound}
            on:newConversationStarted={handleNewConversationStarted}
            on:exampleSaved={handleExampleSaved}
          />
        </div>
      </Resizable.Pane>
    </Resizable.PaneGroup>
  </PageShell>
{/if}

<style>
  :global(.leaflet-container) {
    height: 100% !important;
    width: 100% !important;
  }

  :global(.service-zone-popup) {
    font-family: system-ui, -apple-system, sans-serif;
    max-width: 250px;
  }

  :global(.zone-popup-header) {
    margin-bottom: 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid #e5e7eb;
  }

  :global(.zone-type) {
    background: #f3f4f6;
    color: #6b7280;
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 4px;
    margin-left: 8px;
    text-transform: uppercase;
    font-weight: 500;
  }

  :global(.zone-popup-description) {
    font-size: 13px;
    color: #4b5563;
    margin-bottom: 4px;
  }

  :global(.zone-popup-org),
  :global(.zone-popup-eligibility) {
    font-size: 12px;
    color: #6b7280;
    margin-bottom: 2px;
  }

  /* Custom scrollbar for horizontal example cards */
  .scrollbar-thin {
    scrollbar-width: thin;
  }

  .scrollbar-thin::-webkit-scrollbar {
    height: 6px;
  }

  .scrollbar-thin::-webkit-scrollbar-track {
    background: transparent;
  }

  .scrollbar-thin::-webkit-scrollbar-thumb {
    background: hsl(var(--border));
    border-radius: 3px;
  }

  .scrollbar-thin::-webkit-scrollbar-thumb:hover {
    background: hsl(var(--muted-foreground) / 0.5);
  }
</style>
