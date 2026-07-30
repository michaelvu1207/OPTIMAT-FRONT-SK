# OPTIMAT

OPTIMAT helps seniors and people with disabilities find transportation providers serving trips in Contra Costa County.

- Web application: [https://optimat.us](https://optimat.us)
- Public API: [https://api.optimat.us](https://api.optimat.us)
- OpenAPI 3.1: [https://api.optimat.us/openapi.json](https://api.optimat.us/openapi.json)
- API guide: [docs/public-api.md](docs/public-api.md)
- Production architecture: [docs/migration/2026-07-30-production-cutover.md](docs/migration/2026-07-30-production-cutover.md)

## Architecture

The frontend is a SvelteKit static SPA hosted by AWS Amplify. The public JSON API runs on API Gateway and Node.js 24 Lambda functions backed by Aurora PostgreSQL Serverless v2. Amazon Bedrock powers the rider assistant, Amazon Location provides geocoding/routing, and Amazon Transcribe handles voice input.

## Development

```bash
npm install
cp .env.example .env
npm run dev
```

The default example configuration uses the public production API and requires no browser API key.

## Validation

```bash
npm run check
npm run build
npm run security:secrets

AWS_API_URL=https://api.optimat.us \
  node tests/api-harness.mjs --target aws --skip conversations,chat,tool-calls
```

## Infrastructure

Version-controlled AWS SAM/CloudFormation templates and Lambda code live under `infra/`. Production infrastructure changes must pass SAM validation, TypeScript checks, secret scanning, and API smoke tests before promotion.
