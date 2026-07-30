import { createHandler, jsonResponse } from '../_shared/adapter.js';

const BASE_URL = 'https://api.optimat.us';

const jsonResponseRef = {
  description: 'Successful JSON response',
  content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
};

const errorResponses = {
  '400': { $ref: '#/components/responses/BadRequest' },
  '404': { $ref: '#/components/responses/NotFound' },
  '429': { $ref: '#/components/responses/RateLimited' },
  '500': { $ref: '#/components/responses/ServerError' },
};

function publicOperation(summary: string, tags: string[], extra: Record<string, unknown> = {}) {
  return {
    summary,
    tags,
    security: [],
    responses: { '200': jsonResponseRef, ...errorResponses },
    ...extra,
  };
}

const openApi = {
  openapi: '3.1.0',
  info: {
    title: 'OPTIMAT Public API',
    version: '1.0.0',
    description: 'Public transportation-provider, trip-data, mapping, and rider-assistant API for OPTIMAT. No API key is required for the operations in this document.',
  },
  servers: [{ url: BASE_URL, description: 'Production' }],
  tags: [
    { name: 'System' },
    { name: 'Providers' },
    { name: 'Location' },
    { name: 'Chat' },
    { name: 'Examples' },
    { name: 'Trip data' },
    { name: 'Feedback' },
  ],
  paths: {
    '/': {
      get: publicOperation('API directory', ['System']),
    },
    '/health': {
      get: publicOperation('Health check', ['System']),
    },
    '/openapi.json': {
      get: publicOperation('OpenAPI 3.1 document', ['System']),
    },
    '/providers': {
      get: publicOperation('List transportation providers', ['Providers']),
    },
    '/providers/search': {
      get: publicOperation('Search providers by name', ['Providers'], {
        parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
      }),
    },
    '/providers/map': {
      get: publicOperation('List provider map features', ['Providers']),
    },
    '/providers/filter': {
      post: publicOperation('Find providers for a trip', ['Providers'], {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ProviderFilterRequest' },
            },
          },
        },
      }),
    },
    '/providers/{providerId}': {
      get: publicOperation('Get one provider', ['Providers'], {
        parameters: [{ $ref: '#/components/parameters/ProviderId' }],
      }),
    },
    '/providers/{providerId}/service-zone': {
      get: publicOperation('Get provider service-zone GeoJSON', ['Providers'], {
        parameters: [{ $ref: '#/components/parameters/ProviderId' }],
      }),
    },
    '/geocode': {
      get: publicOperation('Geocode an address with Amazon Location', ['Location'], {
        parameters: [{ name: 'address', in: 'query', required: true, schema: { type: 'string' } }],
      }),
    },
    '/directions': {
      post: publicOperation('Calculate driving or transit directions', ['Location'], {
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/DirectionsRequest' } },
          },
        },
      }),
    },
    '/conversations': {
      post: publicOperation('Create an anonymous conversation', ['Chat'], {
        requestBody: {
          content: {
            'application/json': { schema: { type: 'object', properties: { title: { type: 'string' } } } },
          },
        },
      }),
    },
    '/conversations/{conversationId}': {
      get: publicOperation('Get a conversation and its messages', ['Chat'], {
        description: 'Conversation UUIDs are bearer-like identifiers. Do not publish them.',
        parameters: [{ $ref: '#/components/parameters/ConversationId' }],
      }),
    },
    '/messages': {
      get: publicOperation('List messages in a conversation', ['Chat'], {
        parameters: [{ name: 'conversation_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } }],
      }),
      post: publicOperation('Append a message to a conversation', ['Chat'], {
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/MessageRequest' } },
          },
        },
      }),
    },
    '/messages/{messageId}': {
      get: publicOperation('Get one message', ['Chat'], {
        parameters: [{ name: 'messageId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      }),
    },
    '/chat': {
      post: publicOperation('Run the OPTIMAT rider assistant', ['Chat'], {
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' } },
          },
        },
      }),
    },
    '/tool-calls': {
      get: publicOperation('Get structured tool results for a conversation', ['Chat'], {
        parameters: [
          { name: 'conversation_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'tool_name', in: 'query', required: false, schema: { type: 'string' } },
        ],
      }),
    },
    '/replay': {
      get: publicOperation('Build replay state for a conversation', ['Examples'], {
        parameters: [{ name: 'conversation_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } }],
      }),
    },
    '/chat-examples': {
      get: publicOperation('List approved chat examples', ['Examples']),
    },
    '/chat-examples/{exampleId}': {
      get: publicOperation('Get approved chat-example metadata', ['Examples'], {
        parameters: [{ $ref: '#/components/parameters/ExampleId' }],
      }),
    },
    '/chat-examples/{exampleId}/with-states': {
      get: publicOperation('Get an approved example with replay states', ['Examples'], {
        parameters: [{ $ref: '#/components/parameters/ExampleId' }],
      }),
    },
    '/trip-records/pairs': {
      get: publicOperation('List trip-record pairs', ['Trip data']),
    },
    '/trip-records/pairs-grouped': {
      get: publicOperation('List grouped outbound and return trips', ['Trip data']),
    },
    '/trip-records/stats': {
      get: publicOperation('Get trip-record statistics', ['Trip data']),
    },
    '/trip-records/manifest/pairs': {
      get: publicOperation('List manifest trip pairs', ['Trip data']),
    },
    '/trip-records/manifest/pair-summaries': {
      get: publicOperation('List manifest pair summaries', ['Trip data']),
    },
    '/tri-delta-transit/trips': {
      get: publicOperation('List Tri Delta Transit trips', ['Trip data']),
    },
    '/tri-delta-transit/routes': {
      get: publicOperation('List Tri Delta Transit route overlays', ['Trip data'], {
        parameters: [{ name: 'mode', in: 'query', required: false, schema: { type: 'string', enum: ['driving', 'transit'] } }],
      }),
    },
    '/feedback': {
      post: publicOperation('Submit product feedback', ['Feedback'], {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['comment'],
                properties: {
                  comment: { type: 'string', maxLength: 4000 },
                  rating: { type: 'string', enum: ['up', 'down'] },
                  conversation_id: { type: ['string', 'null'], format: 'uuid' },
                },
              },
            },
          },
        },
      }),
    },
  },
  components: {
    parameters: {
      ProviderId: { name: 'providerId', in: 'path', required: true, schema: { type: 'string' } },
      ConversationId: { name: 'conversationId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ExampleId: { name: 'exampleId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
    },
    schemas: {
      ProviderFilterRequest: {
        type: 'object',
        required: ['source_address'],
        properties: {
          source_address: { type: 'string' },
          destination_address: { type: 'string' },
          provider_type: { type: 'string' },
        },
      },
      DirectionsRequest: {
        type: 'object',
        required: ['origin', 'destination'],
        properties: {
          origin: { type: 'string' },
          destination: { type: 'string' },
          mode: { type: 'string', enum: ['driving', 'transit'], default: 'driving' },
        },
      },
      MessageRequest: {
        type: 'object',
        required: ['conversation_id', 'role', 'content'],
        properties: {
          conversation_id: { type: 'string', format: 'uuid' },
          role: { type: 'string', enum: ['user', 'assistant', 'system'] },
          content: { type: 'string' },
        },
      },
      ChatRequest: {
        type: 'object',
        required: ['conversation_id', 'message'],
        properties: {
          conversation_id: { type: 'string', format: 'uuid' },
          message: { type: 'string' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          success: { type: 'boolean', const: false },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
    },
    responses: {
      BadRequest: { description: 'Invalid request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      NotFound: { description: 'Resource not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      RateLimited: { description: 'Rate limit exceeded', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      ServerError: { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
  'x-optimat-rate-limit': { sustainedRequestsPerSecond: 25, burstRequests: 50 },
};

export const handler = createHandler(async (req) => {
  if (req.pathname === '/openapi.json') return jsonResponse(openApi, 200, req.origin);
  return jsonResponse({
    name: 'OPTIMAT Public API',
    version: '1.0.0',
    status: 'public',
    base_url: BASE_URL,
    authentication: 'No API key is required for public operations.',
    openapi: `${BASE_URL}/openapi.json`,
    documentation: 'https://optimat.us/#/api-docs',
    health: `${BASE_URL}/health`,
    cors: '*',
    rate_limit: { sustained_requests_per_second: 25, burst_requests: 50 },
    administrative_operations: 'Administrative writes are not part of the public contract and require a server-held token.',
  }, 200, req.origin);
});
