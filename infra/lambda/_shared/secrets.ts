/**
 * AWS Secrets Manager Loader
 *
 * Lazy-loads and caches secrets from Secrets Manager.
 * Secrets are fetched once per Lambda cold start and cached in memory.
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({});

const cache = new Map<string, Record<string, string>>();

/**
 * Fetch a secret from Secrets Manager, with in-memory caching.
 * @param secretArn - The ARN or name of the secret
 * @returns Parsed JSON key-value pairs from the secret
 */
export async function getSecret(secretArn: string): Promise<Record<string, string>> {
  const cached = cache.get(secretArn);
  if (cached) return cached;

  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );

  if (!response.SecretString) {
    throw new Error(`Secret ${secretArn} has no string value`);
  }

  const parsed = JSON.parse(response.SecretString) as Record<string, string>;
  cache.set(secretArn, parsed);
  return parsed;
}

/**
 * Get a specific key from a secret.
 * @param secretArn - The ARN or name of the secret
 * @param key - The key to retrieve from the secret JSON
 * @returns The value for the key
 */
export async function getSecretValue(secretArn: string, key: string): Promise<string> {
  const secret = await getSecret(secretArn);
  const value = secret[key];
  if (value === undefined) {
    throw new Error(`Key "${key}" not found in secret ${secretArn}`);
  }
  return value;
}

/**
 * Get the API keys secret. Convenience wrapper for the common case.
 * Reads from API_KEYS_SECRET_ARN environment variable.
 */
export async function getApiKeys(): Promise<Record<string, string>> {
  const arn = process.env.API_KEYS_SECRET_ARN;
  if (!arn) {
    // Fall back to direct env vars for local development
    return {
      GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || '',
      TAVILY_API_KEY: process.env.TAVILY_API_KEY || '',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    };
  }
  return getSecret(arn);
}
