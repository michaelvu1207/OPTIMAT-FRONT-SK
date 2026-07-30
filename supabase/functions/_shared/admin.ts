import { errorResponse } from "./cors.ts";

const ADMIN_TOKEN_ENV = "OPTIMAT_MIGRATION_ADMIN_TOKEN";
const ADMIN_TOKEN_HEADER = "x-optimat-admin-token";

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

export function isMigrationAdminRequest(request: Request): boolean {
  const expected = Deno.env.get(ADMIN_TOKEN_ENV) ?? "";
  const provided = request.headers.get(ADMIN_TOKEN_HEADER) ?? "";
  return expected.length >= 32 && provided.length >= 32 &&
    constantTimeEqual(provided, expected);
}

export function requireMigrationAdmin(
  request: Request,
  origin?: string | null,
): Response | null {
  if (isMigrationAdminRequest(request)) return null;
  return errorResponse("Administrative authentication required", 401, origin);
}
