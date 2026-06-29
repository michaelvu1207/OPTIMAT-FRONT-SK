/**
 * Service Zone Management System for OPTIMAT Map
 * Extends the ping management system to support geographic service zones
 * Integrates with existing ping system for unified map management
 */

import { writable, derived, get } from 'svelte/store';
import { v4 as uuidv4 } from 'uuid';
import { pingManager } from './pingManager.js';

// Service zone type definitions
export const ServiceZoneTypes = {
  PROVIDER: 'provider',
  COVERAGE: 'coverage',
  ELIGIBILITY: 'eligibility',
  CUSTOM: 'custom'
};

// Default service zone configurations
export const ServiceZoneConfigs = {
  [ServiceZoneTypes.PROVIDER]: {
    color: '#3B82F6', // blue-500
    weight: 2,
    opacity: 0.8,
    fillOpacity: 0.2,
    dashArray: null,
    zIndex: 400,
    interactive: true,
    popup: true
  },
  [ServiceZoneTypes.COVERAGE]: {
    color: '#10B981', // emerald-500
    weight: 2,
    opacity: 0.7,
    fillOpacity: 0.15,
    dashArray: '5,5',
    zIndex: 300,
    interactive: true,
    popup: true
  },
  [ServiceZoneTypes.ELIGIBILITY]: {
    color: '#F59E0B', // amber-500
    weight: 2,
    opacity: 0.6,
    fillOpacity: 0.1,
    dashArray: '10,5',
    zIndex: 200,
    interactive: true,
    popup: true
  },
  [ServiceZoneTypes.CUSTOM]: {
    color: '#6B7280', // gray-500
    weight: 2,
    opacity: 0.5,
    fillOpacity: 0.1,
    dashArray: null,
    zIndex: 100,
    interactive: true,
    popup: true
  }
};

// Provider-specific color palette for better visual distinction
const PROVIDER_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEEAD',
  '#D4A5A5', '#9B59B6', '#3498DB', '#E67E22', '#2ECC71',
  '#F39C12', '#E74C3C', '#8E44AD', '#3498DB', '#16A085',
  '#27AE60', '#F39C12', '#E67E22', '#9B59B6', '#34495E'
];

/**
 * Service Zone data structure
 * @typedef {Object} ServiceZone
 * @property {string} id - Unique identifier
 * @property {string} type - Zone type from ServiceZoneTypes
 * @property {Object} geoJson - GeoJSON geometry object
 * @property {string} [label] - Display label
 * @property {string} [description] - Popup description
 * @property {Object} [metadata] - Additional data (e.g., provider info)
 * @property {Object} [config] - Override default styling config
 * @property {number} createdAt - Timestamp
 * @property {boolean} visible - Visibility state
 * @property {Array<Array<number>>} [bounds] - Calculated bounds [[south, west], [north, east]]
 */

// Core service zone store
const serviceZoneStore = writable([]);

/**
 * ServiceZoneManager - Main interface for service zone management
 * Integrates with existing ping manager for unified map control
 */
export class ServiceZoneManager {
  constructor() {
    this.store = serviceZoneStore;
    this.pingManager = pingManager; // Reference to existing ping manager
    this._colorIndex = 0; // Track color assignment for providers
  }

  /**
   * Add a new service zone to the map
   * @param {Object} zoneData - Service zone data
   * @param {string} zoneData.type - Zone type
   * @param {Object} zoneData.geoJson - GeoJSON geometry
   * @param {string} [zoneData.label] - Display label
   * @param {string} [zoneData.description] - Popup description
   * @param {Object} [zoneData.metadata] - Additional data
   * @param {Object} [zoneData.config] - Override config
   * @param {boolean} [focus=false] - Whether to focus map on this zone
   * @returns {string} - Zone ID
   */
  addServiceZone(zoneData, focus = false) {
    const zone = {
      id: uuidv4(),
      type: zoneData.type || ServiceZoneTypes.CUSTOM,
      geoJson: zoneData.geoJson,
      label: zoneData.label || `${zoneData.type} zone`,
      description: zoneData.description || '',
      metadata: zoneData.metadata || {},
      config: this._buildZoneConfig(zoneData),
      createdAt: Date.now(),
      visible: true,
      bounds: this._calculateGeoJsonBounds(zoneData.geoJson)
    };

    // Validate GeoJSON
    if (!this._isValidGeoJson(zone.geoJson)) {
      throw new Error('Invalid GeoJSON provided');
    }

    // Add to store
    this.store.update(zones => [...zones, zone]);

    // Focus map if requested
    if (focus) {
      this.focusOnServiceZone(zone.id);
    }

    return zone.id;
  }

  /**
   * Remove a service zone by ID
   * @param {string} zoneId - Zone ID to remove
   * @returns {boolean} - Success status
   */
  removeServiceZone(zoneId) {
    let removed = false;
    this.store.update(zones => {
      const filtered = zones.filter(z => z.id !== zoneId);
      removed = filtered.length !== zones.length;
      return filtered;
    });
    return removed;
  }

  /**
   * Remove all service zones of a specific type
   * @param {string} type - Zone type to remove
   * @returns {number} - Number of zones removed
   */
  removeServiceZonesByType(type) {
    let removedCount = 0;
    this.store.update(zones => {
      const filtered = zones.filter(z => {
        if (z.type === type) {
          removedCount++;
          return false;
        }
        return true;
      });
      return filtered;
    });
    return removedCount;
  }

  /**
   * Remove service zones by provider ID
   * @param {string} providerId - Provider ID to remove zones for
   * @returns {number} - Number of zones removed
   */
  removeServiceZonesByProvider(providerId) {
    let removedCount = 0;
    this.store.update(zones => {
      const filtered = zones.filter(z => {
        if (z.metadata?.providerId === providerId) {
          removedCount++;
          return false;
        }
        return true;
      });
      return filtered;
    });
    return removedCount;
  }

  /**
   * Clear all service zones
   */
  clearAllServiceZones() {
    this.store.set([]);
    this._colorIndex = 0; // Reset color assignment
  }

  /**
   * Update an existing service zone
   * @param {string} zoneId - Zone ID
   * @param {Object} updates - Fields to update
   * @returns {boolean} - Success status
   */
  updateServiceZone(zoneId, updates) {
    let updated = false;
    this.store.update(zones => {
      return zones.map(zone => {
        if (zone.id === zoneId) {
          updated = true;
          const updatedZone = { ...zone, ...updates };
          
          // Recalculate bounds if GeoJSON changed
          if (updates.geoJson) {
            updatedZone.bounds = this._calculateGeoJsonBounds(updates.geoJson);
          }
          
          return updatedZone;
        }
        return zone;
      });
    });
    return updated;
  }

  /**
   * Get a service zone by ID
   * @param {string} zoneId - Zone ID
   * @returns {ServiceZone|null} - Zone object or null
   */
  getServiceZone(zoneId) {
    const zones = get(this.store);
    return zones.find(z => z.id === zoneId) || null;
  }

  /**
   * Get all service zones of a specific type
   * @param {string} type - Zone type
   * @returns {Array<ServiceZone>} - Array of zones
   */
  getServiceZonesByType(type) {
    const zones = get(this.store);
    return zones.filter(z => z.type === type);
  }

  /**
   * Get service zones by provider ID
   * @param {string} providerId - Provider ID
   * @returns {Array<ServiceZone>} - Array of zones
   */
  getServiceZonesByProvider(providerId) {
    const zones = get(this.store);
    return zones.filter(z => z.metadata?.providerId === providerId);
  }

  /**
   * Toggle service zone visibility
   * @param {string} zoneId - Zone ID
   * @returns {boolean} - New visibility state
   */
  toggleServiceZoneVisibility(zoneId) {
    let newVisibility = false;
    this.store.update(zones => {
      return zones.map(zone => {
        if (zone.id === zoneId) {
          newVisibility = !zone.visible;
          return { ...zone, visible: newVisibility };
        }
        return zone;
      });
    });
    return newVisibility;
  }

  /**
   * Toggle visibility for all zones of a specific type
   * @param {string} type - Zone type
   * @param {boolean} [visible] - Optional explicit visibility state
   * @returns {number} - Number of zones affected
   */
  toggleServiceZonesByType(type, visible = null) {
    let affectedCount = 0;
    this.store.update(zones => {
      return zones.map(zone => {
        if (zone.type === type) {
          affectedCount++;
          const newVisibility = visible !== null ? visible : !zone.visible;
          return { ...zone, visible: newVisibility };
        }
        return zone;
      });
    });
    return affectedCount;
  }

  /**
   * Focus map on a specific service zone
   * @param {string} zoneId - Zone ID
   * @param {number} [padding=20] - Padding around bounds
   */
  focusOnServiceZone(zoneId, padding = 20) {
    const zone = this.getServiceZone(zoneId);
    if (!zone || !zone.bounds) return;

    const bounds = zone.bounds;
    this._focusOnBounds(bounds, padding);
  }

  /**
   * Focus map to fit all visible service zones
   * @param {string} [type] - Optional: only fit zones of this type
   * @param {number} [padding=20] - Padding around bounds
   */
  focusOnAllServiceZones(type = null, padding = 20) {
    const zones = get(this.store).filter(z => 
      z.visible && z.bounds && (type === null || z.type === type)
    );

    if (zones.length === 0) return;

    if (zones.length === 1) {
      this.focusOnServiceZone(zones[0].id, padding);
      return;
    }

    // Calculate combined bounds for multiple zones
    const combinedBounds = this._calculateCombinedBounds(zones.map(z => z.bounds));
    this._focusOnBounds(combinedBounds, padding);
  }

  /**
   * Focus map to fit both service zones and pings
   * @param {number} [padding=20] - Padding around bounds
   */
  focusOnZonesAndPings(padding = 20) {
    const zones = get(this.store).filter(z => z.visible && z.bounds);
    const pings = get(this.pingManager.store).filter(p => p.visible);

    if (zones.length === 0 && pings.length === 0) return;

    let allBounds = [];

    // Add zone bounds
    zones.forEach(zone => {
      if (zone.bounds) {
        allBounds.push(zone.bounds);
      }
    });

    // Convert ping coordinates to bounds
    pings.forEach(ping => {
      const coord = ping.coordinates;
      allBounds.push([[coord[0], coord[1]], [coord[0], coord[1]]]);
    });

    if (allBounds.length === 0) return;

    const combinedBounds = this._calculateCombinedBounds(allBounds);
    this._focusOnBounds(combinedBounds, padding);
  }

  /**
   * Batch add multiple service zones
   * @param {Array<Object>} zonesData - Array of zone data
   * @param {boolean} [focus=false] - Whether to focus on all added zones
   * @returns {Array<string>} - Array of zone IDs
   */
  addServiceZones(zonesData, focus = false) {
    const zoneIds = [];
    
    this.store.update(zones => {
      const newZones = zonesData.map(zoneData => {
        const zone = {
          id: uuidv4(),
          type: zoneData.type || ServiceZoneTypes.CUSTOM,
          geoJson: zoneData.geoJson,
          label: zoneData.label || `${zoneData.type} zone`,
          description: zoneData.description || '',
          metadata: zoneData.metadata || {},
          config: this._buildZoneConfig(zoneData),
          createdAt: Date.now(),
          visible: true,
          bounds: this._calculateGeoJsonBounds(zoneData.geoJson)
        };
        
        if (!this._isValidGeoJson(zone.geoJson)) {
          throw new Error(`Invalid GeoJSON provided for zone: ${JSON.stringify(zoneData)}`);
        }
        
        zoneIds.push(zone.id);
        return zone;
      });
      
      return [...zones, ...newZones];
    });

    if (focus && zoneIds.length > 0) {
      this.focusOnAllServiceZones();
    }

    return zoneIds;
  }

  /**
   * Add service zones from provider data (convenience method)
   * @param {Array<Object>} providers - Provider data with service_zone field
   * @param {boolean} [focus=false] - Whether to focus on added zones
   * @returns {Array<string>} - Array of zone IDs
   */
  addProviderServiceZones(providers, focus = false) {
    const zonesData = providers
      .filter(provider => provider.service_zone)
      .map((provider, index) => {
        const geoJson = this._parseServiceZone(provider.service_zone);
        if (!geoJson) return null;

        const color = PROVIDER_COLORS[this._colorIndex % PROVIDER_COLORS.length];

        // persist color on provider for UI use
        provider._zone_color = color;

        return {
          type: ServiceZoneTypes.PROVIDER,
          geoJson: geoJson,
          label: provider.provider_name || `Provider ${index + 1}`,
          description: this._buildProviderDescription(provider),
          metadata: {
            provider: provider,
            providerId: provider.id || provider.provider_id,
            providerType: provider.provider_type
          },
          config: {
            color,
            dashArray: index % 2 ? '3' : null
          }
        };
      })
      .filter(Boolean);

    this._colorIndex += zonesData.length;

    if (zonesData.length === 0) return [];

    return this.addServiceZones(zonesData, focus);
  }

  getProviderColor(providerId) {
    const zones = get(this.store);
    const match = zones.find(z => z.metadata?.providerId === providerId);
    return match?.config?.color || null;
  }

  /**
   * Hide all provider zones except the selected providerId and focus on it.
   */
  focusOnProvider(providerId, padding = 20) {
    let targetZoneId = null;
    this.store.update(zones =>
      zones.map(z => {
        const isTarget = z.metadata?.providerId === providerId;
        if (isTarget) targetZoneId = z.id;
        return { ...z, visible: isTarget && z.visible !== false };
      })
    );
    if (targetZoneId) {
      this.focusOnServiceZone(targetZoneId, padding);
    }
  }

  // Private helper methods

  /**
   * Build zone configuration by merging defaults with overrides
   */
  _buildZoneConfig(zoneData) {
    const baseConfig = ServiceZoneConfigs[zoneData.type || ServiceZoneTypes.CUSTOM];
    const customConfig = zoneData.config || {};
    
    // For provider zones, assign unique colors
    if (zoneData.type === ServiceZoneTypes.PROVIDER && !customConfig.color) {
      customConfig.color = PROVIDER_COLORS[this._colorIndex % PROVIDER_COLORS.length];
      this._colorIndex++;
    }
    
    return { ...baseConfig, ...customConfig };
  }

  /**
   * Parse service zone string to GeoJSON
   */
  _parseServiceZone(zoneString) {
    try {
      if (typeof zoneString === 'object') {
        return zoneString; // Already parsed
      }
      return JSON.parse(zoneString);
    } catch (e) {
      console.error('Error parsing service zone:', e);
      return null;
    }
  }

  /**
   * Build provider description for popup
   */
  _buildProviderDescription(provider) {
    const parts = [];
    if (provider.provider_type) parts.push(`Type: ${provider.provider_type}`);
    if (provider.provider_org) parts.push(`Organization: ${provider.provider_org}`);

    // Normalize eligibility_reqs to array of strings
    let elig = provider.eligibility_reqs;
    if (typeof elig === 'string') {
      try {
        elig = JSON.parse(elig);
      } catch {
        // ignore
      }
    }
    if (elig && !Array.isArray(elig) && typeof elig === 'object') {
      const eligibility = typeof elig.eligibility === 'string'
        ? elig.eligibility.trim()
        : typeof elig.eligibility_text === 'string'
          ? elig.eligibility_text.trim()
          : '';
      const proof = typeof elig.proof === 'string'
        ? elig.proof.trim()
        : typeof elig.proof_process === 'string'
          ? elig.proof_process.trim()
          : '';
      if (eligibility || proof) {
        elig = [
          eligibility ? `Eligibility: ${eligibility}` : null,
          proof ? `Proof: ${proof}` : null
        ].filter(Boolean);
      } else if (Array.isArray(elig.eligibility_reqs)) {
        elig = elig.eligibility_reqs;
      }
    }
    if (elig && !Array.isArray(elig)) {
      elig = [String(elig)];
    }

    if (Array.isArray(elig) && elig.length) {
      const formatted = elig
        .map((req) => {
          if (typeof req === 'string') return req;
          if (req && typeof req === 'object') {
            const type = typeof req.type === 'string' ? req.type : '';
            const proof = typeof req.proof === 'string' ? req.proof : '';
            if (type && proof) return `${type} (${proof})`;
            if (type) return type;
          }
          return String(req);
        })
        .filter(Boolean);
      if (formatted.length) parts.push(`Eligibility: ${formatted.join(', ')}`);
    }
    return parts.join('\n');
  }

  /**
   * Validate GeoJSON structure
   */
  _isValidGeoJson(geoJson) {
    return geoJson && 
           typeof geoJson === 'object' && 
           (geoJson.type === 'Polygon' || 
            geoJson.type === 'MultiPolygon' ||
            geoJson.type === 'Feature' ||
            geoJson.type === 'FeatureCollection');
  }

  /**
   * Calculate bounds for GeoJSON geometry
   */
  _calculateGeoJsonBounds(geoJson) {
    if (!geoJson) return null;

    try {
      const coordinates = this._extractCoordinates(geoJson);
      if (coordinates.length === 0) return null;

      const lats = coordinates.map(c => c[1]); // latitude is second in [lng, lat]
      const lngs = coordinates.map(c => c[0]); // longitude is first

      return [
        [Math.min(...lats), Math.min(...lngs)], // southwest
        [Math.max(...lats), Math.max(...lngs)]  // northeast
      ];
    } catch (error) {
      console.error('Error calculating GeoJSON bounds:', error);
      return null;
    }
  }

  /**
   * Extract coordinates from various GeoJSON structures
   */
  _extractCoordinates(geoJson) {
    const coordinates = [];

    function flattenCoordinates(coords, depth = 0) {
      if (typeof coords[0] === 'number') {
        coordinates.push(coords);
      } else {
        coords.forEach(coord => flattenCoordinates(coord, depth + 1));
      }
    }

    if (geoJson.type === 'Feature') {
      if (geoJson.geometry) {
        flattenCoordinates(geoJson.geometry.coordinates);
      }
    } else if (geoJson.type === 'FeatureCollection') {
      geoJson.features.forEach(feature => {
        if (feature.geometry) {
          flattenCoordinates(feature.geometry.coordinates);
        }
      });
    } else if (geoJson.coordinates) {
      flattenCoordinates(geoJson.coordinates);
    }

    return coordinates;
  }

  /**
   * Calculate combined bounds from multiple bounds
   */
  _calculateCombinedBounds(boundsArray) {
    if (boundsArray.length === 0) return null;

    const allSouth = boundsArray.map(b => b[0][0]);
    const allWest = boundsArray.map(b => b[0][1]);
    const allNorth = boundsArray.map(b => b[1][0]);
    const allEast = boundsArray.map(b => b[1][1]);

    return [
      [Math.min(...allSouth), Math.min(...allWest)], // southwest
      [Math.max(...allNorth), Math.max(...allEast)]  // northeast
    ];
  }

  /**
   * Focus map on bounds using ping manager
   */
  _focusOnBounds(bounds, padding = 20) {
    if (!bounds) return;

    const center = [
      (bounds[0][0] + bounds[1][0]) / 2, // latitude
      (bounds[0][1] + bounds[1][1]) / 2  // longitude
    ];

    const latDiff = bounds[1][0] - bounds[0][0];
    const lngDiff = bounds[1][1] - bounds[0][1];
    const maxDiff = Math.max(latDiff, lngDiff);

    // Calculate zoom level based on bounds size
    let zoom = 15;
    if (maxDiff > 10) zoom = 6;
    else if (maxDiff > 5) zoom = 7;
    else if (maxDiff > 2) zoom = 8;
    else if (maxDiff > 1) zoom = 9;
    else if (maxDiff > 0.5) zoom = 10;
    else if (maxDiff > 0.2) zoom = 11;
    else if (maxDiff > 0.1) zoom = 12;
    else if (maxDiff > 0.05) zoom = 13;
    else if (maxDiff > 0.02) zoom = 14;

    this.pingManager.focusOnCoordinates(center, zoom);
  }
}

// Create singleton instance
export const serviceZoneManager = new ServiceZoneManager();

// Export stores for component consumption
export const serviceZones = serviceZoneManager.store;

// Derived stores for convenience
export const visibleServiceZones = derived(serviceZones, $zones => 
  $zones.filter(zone => zone.visible)
);

export const serviceZonesByType = derived(serviceZones, $zones => {
  const grouped = {};
  for (const type of Object.values(ServiceZoneTypes)) {
    grouped[type] = $zones.filter(z => z.type === type);
  }
  return grouped;
});

export const serviceZoneCount = derived(serviceZones, $zones => $zones.length);
export const visibleServiceZoneCount = derived(visibleServiceZones, $zones => $zones.length);

// Provider-specific derived stores
export const providerServiceZones = derived(serviceZones, $zones =>
  $zones.filter(z => z.type === ServiceZoneTypes.PROVIDER)
);

export const visibleProviderServiceZones = derived(providerServiceZones, $zones =>
  $zones.filter(z => z.visible)
);
