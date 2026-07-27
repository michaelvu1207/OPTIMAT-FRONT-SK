#!/usr/bin/env node

/**
 * OPTIMAT Database Migration Script
 * Migrates data from Supabase PostgreSQL to Aurora PostgreSQL.
 *
 * Usage:
 *   node scripts/migrate-db.mjs                  # full migration
 *   node scripts/migrate-db.mjs --dry-run        # show plan without writing
 *   node scripts/migrate-db.mjs --verify-only    # compare row counts only
 *
 * Environment:
 *   Reads from scripts/.env (or scripts/.env.local) via dotenv,
 *   or from process.env directly.
 */

import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Load .env from scripts/ directory if dotenv is available
try {
  const dotenv = await import("dotenv");
  dotenv.config({ path: path.join(__dirname, ".env") });
  dotenv.config({ path: path.join(__dirname, ".env.local"), override: true });
} catch {
  // dotenv not installed — rely on process.env
}

const FLAGS = {
  dryRun: process.argv.includes("--dry-run"),
  verifyOnly: process.argv.includes("--verify-only"),
};

/** Tables in the optimat schema */
const OPTIMAT_TABLES = [
  "providers",
  "conversations",
  "messages",
  "chat_examples",
  "conversation_states",
  "find_providers_calls",
  "search_addresses_calls",
  "get_provider_info_calls",
  "general_question_calls",
  "tool_calls",
  "trip_record_pairs_raw",
  "demand_response_manifest_review",
];

/** Tables in the public schema (may not exist in Supabase) */
const PUBLIC_TABLES = [
  "tri_delta_transit",
  "transit_driving_driving",
];

/**
 * Migration order matters because of foreign key dependencies.
 * Parent tables must be populated before children.
 */
const MIGRATION_ORDER = [
  // Independent tables first
  { schema: "optimat", table: "providers" },
  { schema: "optimat", table: "conversations" },
  // Depends on conversations
  { schema: "optimat", table: "messages" },
  { schema: "optimat", table: "chat_examples" },
  { schema: "optimat", table: "find_providers_calls" },
  { schema: "optimat", table: "search_addresses_calls" },
  { schema: "optimat", table: "get_provider_info_calls" },
  { schema: "optimat", table: "general_question_calls" },
  { schema: "optimat", table: "tool_calls" },
  // Depends on conversations + chat_examples
  { schema: "optimat", table: "conversation_states" },
  // No FK dependencies
  { schema: "optimat", table: "trip_record_pairs_raw" },
  { schema: "optimat", table: "demand_response_manifest_review" },
  // Public schema tables
  { schema: "public", table: "tri_delta_transit" },
  { schema: "public", table: "transit_driving_driving" },
];

// ---------------------------------------------------------------------------
// Database connections
// ---------------------------------------------------------------------------

function createSupabasePool() {
  return new pg.Pool({
    host: process.env.SUPABASE_DB_HOST,
    port: parseInt(process.env.SUPABASE_DB_PORT || "5432", 10),
    database: process.env.SUPABASE_DB_NAME || "postgres",
    user: process.env.SUPABASE_DB_USER || "postgres",
    password: process.env.SUPABASE_DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
    max: 5,
    connectionTimeoutMillis: 15000,
  });
}

function createAuroraPool() {
  return new pg.Pool({
    host: process.env.AURORA_DB_HOST,
    port: parseInt(process.env.AURORA_DB_PORT || "5432", 10),
    database: process.env.AURORA_DB_NAME || "optimat",
    user: process.env.AURORA_DB_USER || "optimat_admin",
    password: process.env.AURORA_DB_PASSWORD,
    ssl: process.env.AURORA_DB_SSL === "false" ? false : { rejectUnauthorized: false },
    max: 5,
    connectionTimeoutMillis: 15000,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the fully qualified table name.
 */
function fqn(schema, table) {
  // Public schema tables with quoted column names need special handling
  return `"${schema}"."${table}"`;
}

/**
 * Escape a value for inclusion in a SQL literal.
 * Returns the SQL representation (including quotes for strings).
 */
function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return String(value);
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value === "object") {
    // JSONB or array
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  }
  if (typeof value === "string") {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Get the primary key or unique columns for conflict resolution.
 */
function getConflictTarget(schema, table) {
  const targets = {
    "optimat.providers": "(id)",
    "optimat.conversations": "(id)",
    "optimat.messages": "(id)",
    "optimat.chat_examples": "(id)",
    "optimat.conversation_states": "(id)",
    "optimat.find_providers_calls": "(id)",
    "optimat.search_addresses_calls": "(id)",
    "optimat.get_provider_info_calls": "(id)",
    "optimat.general_question_calls": "(id)",
    "optimat.tool_calls": "(id)",
  };
  return targets[`${schema}.${table}`] || null;
}

/**
 * Count rows in a table. Returns -1 if the table does not exist.
 */
async function countRows(pool, schema, table) {
  try {
    const result = await pool.query(`SELECT COUNT(*) AS cnt FROM ${fqn(schema, table)}`);
    return parseInt(result.rows[0].cnt, 10);
  } catch (err) {
    if (err.code === "42P01") {
      // relation does not exist
      return -1;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Core migration logic
// ---------------------------------------------------------------------------

/**
 * Apply the DDL script to Aurora.
 */
async function applyDDL(auroraPool) {
  const ddlPath = path.join(__dirname, "ddl", "tables.sql");
  const ddl = fs.readFileSync(ddlPath, "utf-8");

  console.log("\n--- Applying DDL to Aurora ---");

  if (FLAGS.dryRun) {
    console.log("[DRY RUN] Would execute DDL from:", ddlPath);
    console.log(`[DRY RUN] DDL is ${ddl.length} characters`);
    return;
  }

  const client = await auroraPool.connect();
  try {
    await client.query(ddl);
    console.log("DDL applied successfully.");
  } finally {
    client.release();
  }
}

/**
 * Migrate a single table from Supabase to Aurora.
 */
async function migrateTable(supabasePool, auroraPool, schema, table) {
  const qualifiedName = `${schema}.${table}`;
  console.log(`\n  Migrating ${qualifiedName} ...`);

  // Check if source table exists
  const sourceCount = await countRows(supabasePool, schema, table);
  if (sourceCount === -1) {
    console.log(`    Source table ${qualifiedName} does not exist — skipping.`);
    return { table: qualifiedName, source: 0, inserted: 0, skipped: true };
  }
  if (sourceCount === 0) {
    console.log(`    Source table ${qualifiedName} has 0 rows — nothing to migrate.`);
    return { table: qualifiedName, source: 0, inserted: 0, skipped: false };
  }

  console.log(`    Source rows: ${sourceCount}`);

  // Export all rows from Supabase
  const selectResult = await supabasePool.query(`SELECT * FROM ${fqn(schema, table)}`);
  const rows = selectResult.rows;
  if (rows.length === 0) {
    return { table: qualifiedName, source: 0, inserted: 0, skipped: false };
  }

  const columns = Object.keys(rows[0]);
  const conflictTarget = getConflictTarget(schema, table);

  if (FLAGS.dryRun) {
    console.log(`    [DRY RUN] Would insert ${rows.length} rows into ${qualifiedName}`);
    console.log(`    [DRY RUN] Columns: ${columns.join(", ")}`);
    if (conflictTarget) {
      console.log(`    [DRY RUN] ON CONFLICT ${conflictTarget} DO NOTHING`);
    }
    return { table: qualifiedName, source: rows.length, inserted: 0, skipped: false, dryRun: true };
  }

  // Insert in batches of 100 rows
  const BATCH_SIZE = 100;
  let totalInserted = 0;

  const auroraClient = await auroraPool.connect();
  try {
    await auroraClient.query("BEGIN");

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const valueClauses = batch.map((row) => {
        const vals = columns.map((col) => sqlLiteral(row[col]));
        return `(${vals.join(", ")})`;
      });

      // Quote column names to handle reserved words and special characters
      const quotedColumns = columns.map((c) => `"${c}"`).join(", ");
      const conflictClause = conflictTarget
        ? ` ON CONFLICT ${conflictTarget} DO NOTHING`
        : "";

      const sql = `INSERT INTO ${fqn(schema, table)} (${quotedColumns}) VALUES ${valueClauses.join(", ")}${conflictClause}`;

      const insertResult = await auroraClient.query(sql);
      totalInserted += insertResult.rowCount || 0;
    }

    await auroraClient.query("COMMIT");
    console.log(`    Inserted: ${totalInserted} rows`);
  } catch (err) {
    await auroraClient.query("ROLLBACK");
    console.error(`    ERROR migrating ${qualifiedName}:`, err.message);
    throw err;
  } finally {
    auroraClient.release();
  }

  return { table: qualifiedName, source: rows.length, inserted: totalInserted, skipped: false };
}

/**
 * Verify row counts between Supabase and Aurora.
 */
async function verifyMigration(supabasePool, auroraPool) {
  console.log("\n--- Verification: Row Count Comparison ---\n");

  const allTables = [
    ...OPTIMAT_TABLES.map((t) => ({ schema: "optimat", table: t })),
    ...PUBLIC_TABLES.map((t) => ({ schema: "public", table: t })),
  ];

  const results = [];
  const colWidths = { name: 45, source: 10, target: 10, status: 10 };

  console.log(
    "Table".padEnd(colWidths.name) +
    "Supabase".padStart(colWidths.source) +
    "Aurora".padStart(colWidths.target) +
    "Status".padStart(colWidths.status)
  );
  console.log("-".repeat(colWidths.name + colWidths.source + colWidths.target + colWidths.status));

  for (const { schema, table } of allTables) {
    const qualifiedName = `${schema}.${table}`;
    const sourceCount = await countRows(supabasePool, schema, table);
    const targetCount = await countRows(auroraPool, schema, table);

    let status;
    if (sourceCount === -1 && targetCount === -1) {
      status = "N/A";
    } else if (sourceCount === -1) {
      status = "SRC N/A";
    } else if (targetCount === -1) {
      status = "TGT N/A";
    } else if (sourceCount === targetCount) {
      status = "OK";
    } else {
      status = "MISMATCH";
    }

    const srcStr = sourceCount === -1 ? "—" : String(sourceCount);
    const tgtStr = targetCount === -1 ? "—" : String(targetCount);

    console.log(
      qualifiedName.padEnd(colWidths.name) +
      srcStr.padStart(colWidths.source) +
      tgtStr.padStart(colWidths.target) +
      status.padStart(colWidths.status)
    );

    results.push({ table: qualifiedName, source: sourceCount, target: targetCount, status });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== OPTIMAT Database Migration ===");
  console.log(`Mode: ${FLAGS.dryRun ? "DRY RUN" : FLAGS.verifyOnly ? "VERIFY ONLY" : "FULL MIGRATION"}`);
  console.log(`Time: ${new Date().toISOString()}`);

  // Validate required env vars
  if (!process.env.SUPABASE_DB_HOST || !process.env.SUPABASE_DB_PASSWORD) {
    console.error("ERROR: SUPABASE_DB_HOST and SUPABASE_DB_PASSWORD are required.");
    process.exit(1);
  }
  if (!FLAGS.verifyOnly && !process.env.AURORA_DB_HOST) {
    // For verify-only we still need Aurora, but let's allow it to fail gracefully
  }
  if (!process.env.AURORA_DB_HOST || !process.env.AURORA_DB_PASSWORD) {
    console.error("ERROR: AURORA_DB_HOST and AURORA_DB_PASSWORD are required.");
    process.exit(1);
  }

  const supabasePool = createSupabasePool();
  const auroraPool = createAuroraPool();

  try {
    // Test connections
    console.log("\nTesting Supabase connection...");
    await supabasePool.query("SELECT 1");
    console.log("  Connected to Supabase.");

    console.log("Testing Aurora connection...");
    await auroraPool.query("SELECT 1");
    console.log("  Connected to Aurora.");

    if (FLAGS.verifyOnly) {
      // Verify only — skip DDL and data migration
      const results = await verifyMigration(supabasePool, auroraPool);
      const mismatches = results.filter((r) => r.status === "MISMATCH");
      if (mismatches.length > 0) {
        console.log(`\nWARNING: ${mismatches.length} table(s) have row count mismatches.`);
      } else {
        console.log("\nAll tables verified successfully.");
      }
    } else {
      // Full migration

      // Step 1: Apply DDL
      await applyDDL(auroraPool);

      // Step 2: Migrate each table in dependency order
      console.log("\n--- Migrating Data ---");
      const migrationResults = [];

      for (const { schema, table } of MIGRATION_ORDER) {
        try {
          const result = await migrateTable(supabasePool, auroraPool, schema, table);
          migrationResults.push(result);
        } catch (err) {
          migrationResults.push({
            table: `${schema}.${table}`,
            source: "?",
            inserted: 0,
            skipped: false,
            error: err.message,
          });
        }
      }

      // Step 3: Verify
      const verifyResults = await verifyMigration(supabasePool, auroraPool);

      // Summary
      console.log("\n--- Migration Summary ---\n");

      const totalSource = migrationResults.reduce((sum, r) => sum + (typeof r.source === "number" ? r.source : 0), 0);
      const totalInserted = migrationResults.reduce((sum, r) => sum + (r.inserted || 0), 0);
      const errors = migrationResults.filter((r) => r.error);
      const skipped = migrationResults.filter((r) => r.skipped);
      const mismatches = verifyResults.filter((r) => r.status === "MISMATCH");

      console.log(`Tables processed: ${migrationResults.length}`);
      console.log(`Total source rows: ${totalSource}`);
      console.log(`Total inserted rows: ${totalInserted}`);
      console.log(`Tables skipped (not in source): ${skipped.length}`);
      console.log(`Errors: ${errors.length}`);
      console.log(`Verification mismatches: ${mismatches.length}`);

      if (errors.length > 0) {
        console.log("\nErrors:");
        for (const r of errors) {
          console.log(`  ${r.table}: ${r.error}`);
        }
      }

      if (FLAGS.dryRun) {
        console.log("\n[DRY RUN] No data was written. Re-run without --dry-run to perform the migration.");
      }
    }
  } finally {
    await supabasePool.end();
    await auroraPool.end();
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
