-- Explicitly publish only the supplied agency snapshots alongside LINK.
BEGIN;
ALTER TABLE optimat.operation_imports DROP CONSTRAINT IF EXISTS operation_imports_source_check;
ALTER TABLE optimat.operation_imports ADD CONSTRAINT operation_imports_source_check
  CHECK (source IN ('LINK','WESTCAT','TDT','MM'));
COMMENT ON TABLE optimat.operation_trips IS
  'Private agency operational records. Coordinates are city reference points; times are actual local America/Los_Angeles wall times where supplied. Missing identifiers and times are never synthesized.';
COMMIT;
