# Service Zone Management System

## Overview

The Service Zone Management System extends the existing ping system to support displaying and managing paratransit provider service zones on the map. It provides a unified interface for handling geographic polygons/boundaries while maintaining architectural consistency with the existing ping management system.

## Architecture

### Core Components

1. **ServiceZoneManager** (`/src/lib/serviceZoneManager.js`)
   - Main interface for service zone management
   - Integrates with existing PingManager for unified map control
   - Handles GeoJSON polygon data and styling

2. **ServiceZoneControls** (`/src/components/ServiceZoneControls.svelte`)
   - User interface component for zone visibility and management
   - Floating control panel with zone type filters
   - Focus and clearing functionality

3. **ChatView Integration** (`/src/routes/ChatView.svelte`)
   - Enhanced map rendering with service zones
   - Integrated popup system with provider information
   - Coordinated focus management with pings

### Data Structure

```javascript
ServiceZone {
  id: string,              // Unique identifier
  type: string,            // Zone type (provider, coverage, eligibility, custom)
  geoJson: Object,         // GeoJSON geometry object
  label: string,           // Display label
  description: string,     // Popup description
  metadata: Object,        // Additional data (provider info, etc.)
  config: Object,          // Styling configuration
  createdAt: number,       // Timestamp
  visible: boolean,        // Visibility state
  bounds: Array            // Calculated bounds [[south, west], [north, east]]
}
```

## Key Features

### 1. Zone Type Management
- **Provider Zones**: Service areas for transportation providers
- **Coverage Areas**: General coverage regions
- **Eligibility Zones**: Areas with specific eligibility requirements
- **Custom Zones**: User-defined or special-purpose zones

### 2. Visual Styling System
- Unique colors for different providers (20-color palette)
- Configurable styling options (weight, opacity, dash patterns)
- Hover effects with enhanced visual feedback
- Z-index management for proper layering

### 3. Interactive Features
- Click-to-focus on individual zones
- Enhanced popups with provider information
- Hover effects for better user experience
- Toggle visibility by zone type

### 4. Integration with Ping System
- Unified focus management between zones and pings
- Coordinated map updates and bounds calculation
- Consistent architectural patterns and API design
- Shared cleanup and lifecycle management

## Usage Examples

### Basic Service Zone Management

```javascript
import { serviceZoneManager, ServiceZoneTypes } from './serviceZoneManager.js';

// Add a single service zone
const zoneId = serviceZoneManager.addServiceZone({
  type: ServiceZoneTypes.PROVIDER,
  geoJson: providerGeoJson,
  label: 'Metro Transit Service Area',
  description: 'Weekday service: 6 AM - 10 PM',
  metadata: { providerId: 'metro-123', providerType: 'Fixed Route' }
});

// Add multiple provider zones from API response
const zoneIds = serviceZoneManager.addProviderServiceZones(providers, true);

// Focus on all zones and pings together
serviceZoneManager.focusOnZonesAndPings();

// Toggle visibility of provider zones
serviceZoneManager.toggleServiceZonesByType(ServiceZoneTypes.PROVIDER, false);

// Clear all zones
serviceZoneManager.clearAllServiceZones();
```

### Provider Integration

```javascript
// Add zones from provider API response
async function handleProviderResponse(providers) {
  // Clear existing zones
  serviceZoneManager.clearAllServiceZones();
  
  // Add service zones for providers that have them
  if (providers.length > 0) {
    serviceZoneManager.addProviderServiceZones(providers, false);
    serviceZoneManager.focusOnZonesAndPings();
  }
}
```

### Reactive Store Usage in Svelte

```svelte
<script>
  import { visibleServiceZones, serviceZonesByType } from './serviceZoneManager.js';
  
  // React to zone changes
  $: console.log(`Visible zones: ${$visibleServiceZones.length}`);
  
  // Display zone statistics
  $: providerZones = $serviceZonesByType.provider;
</script>

<!-- Render zones in template -->
{#each $visibleServiceZones as zone (zone.id)}
  <GeoJSON json={zone.geoJson} options={{style: () => zone.config}} />
{/each}
```

## Configuration Options

### Zone Types and Default Configs

```javascript
ServiceZoneConfigs = {
  provider: {
    color: '#3B82F6',    // blue-500
    weight: 2,
    opacity: 0.8,
    fillOpacity: 0.2,
    dashArray: null,
    zIndex: 400,
    interactive: true,
    popup: true
  },
  coverage: {
    color: '#10B981',    // emerald-500
    weight: 2,
    opacity: 0.7,
    fillOpacity: 0.15,
    dashArray: '5,5',
    zIndex: 300
  },
  // ... other types
}
```

### Provider Color Palette

The system uses a 20-color palette for visual distinction:
```javascript
PROVIDER_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEEAD',
  '#D4A5A5', '#9B59B6', '#3498DB', '#E67E22', '#2ECC71',
  // ... 10 more colors
];
```

## API Reference

### ServiceZoneManager Methods

#### Zone Management
- `addServiceZone(zoneData, focus)` - Add single zone
- `addServiceZones(zonesData, focus)` - Add multiple zones
- `addProviderServiceZones(providers, focus)` - Add from provider data
- `removeServiceZone(zoneId)` - Remove by ID
- `removeServiceZonesByType(type)` - Remove by type
- `removeServiceZonesByProvider(providerId)` - Remove by provider
- `clearAllServiceZones()` - Remove all zones

#### Visibility Control
- `toggleServiceZoneVisibility(zoneId)` - Toggle single zone
- `toggleServiceZonesByType(type, visible)` - Toggle by type

#### Map Focus
- `focusOnServiceZone(zoneId, padding)` - Focus on single zone
- `focusOnAllServiceZones(type, padding)` - Focus on all/type
- `focusOnZonesAndPings(padding)` - Focus on zones and pings

#### Data Access
- `getServiceZone(zoneId)` - Get zone by ID
- `getServiceZonesByType(type)` - Get zones by type
- `getServiceZonesByProvider(providerId)` - Get zones by provider

### Reactive Stores

```javascript
// Core stores
serviceZones           // All zones
visibleServiceZones    // Only visible zones

// Derived stores
serviceZonesByType     // Grouped by type
serviceZoneCount       // Total count
visibleServiceZoneCount // Visible count
providerServiceZones   // Provider zones only
visibleProviderServiceZones // Visible provider zones
```

## Performance Considerations

### 1. Bounds Calculation
- Bounds are pre-calculated when zones are added
- Cached for efficient focus operations
- Supports complex GeoJSON structures (Polygon, MultiPolygon, FeatureCollection)

### 2. Layer Management
- Proper z-index ordering for visual layering
- Efficient Leaflet layer updates through Svelte reactivity
- Memory management through proper cleanup

### 3. Color Assignment
- Efficient color cycling for provider zones
- Deterministic color assignment for consistency
- Visual distinction through alternating dash patterns

## Integration Notes

### Existing System Compatibility
- Maintains all existing ping system functionality
- Uses same focus management system as PingManager
- Consistent store patterns and API design
- Shared lifecycle management (mount/unmount cleanup)

### GeoJSON Support
- Supports Polygon, MultiPolygon geometries
- Handles Feature and FeatureCollection formats
- Robust parsing with error handling
- Coordinate extraction for bounds calculation

### User Experience
- Enhanced popups with provider information
- Hover effects for better interactivity
- Click-to-focus for zone exploration
- Comprehensive controls panel for management

## Future Enhancements

### Potential Features
1. **Zone Filtering**: Filter zones by provider characteristics
2. **Custom Styling**: User-defined zone styling options
3. **Zone Analytics**: Statistics and coverage analysis
4. **Export/Import**: Save/load zone configurations
5. **Performance Optimization**: Large dataset handling improvements
6. **Mobile Optimization**: Touch-friendly interactions

### Extension Points
1. **Custom Zone Types**: Additional zone type definitions
2. **Styling Plugins**: External styling system integration
3. **Data Sources**: Support for additional GeoJSON data sources
4. **Integration APIs**: REST API for zone management

## Troubleshooting

### Common Issues

1. **Zones Not Displaying**
   - Check GeoJSON validity
   - Verify zone visibility state
   - Confirm zone bounds are calculated

2. **Performance Issues**
   - Limit number of concurrent zones
   - Optimize GeoJSON complexity
   - Use appropriate zoom levels

3. **Focus Not Working**
   - Ensure zones have valid bounds
   - Check coordinate system (lat/lng order)
   - Verify ping manager integration

### Debug Tools

```javascript
// Check zone status
console.log('Zones:', serviceZoneManager.store.get());
console.log('Visible zones:', get(visibleServiceZones));

// Validate GeoJSON
const zone = serviceZoneManager.getServiceZone(zoneId);
console.log('Zone bounds:', zone?.bounds);

// Test focus system
serviceZoneManager.focusOnAllServiceZones();
```

## Testing

### Unit Testing
- Zone addition/removal functionality
- Bounds calculation accuracy
- Visibility toggle operations
- GeoJSON parsing validation

### Integration Testing
- ChatView component integration
- Ping system coordination
- Store reactivity verification
- Focus management testing

### User Acceptance Testing
- Zone visibility controls
- Map interaction functionality
- Provider data integration
- Performance with real data
