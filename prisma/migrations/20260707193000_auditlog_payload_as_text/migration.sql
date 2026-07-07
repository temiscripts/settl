-- AlterTable
-- Postgres jsonb does not preserve key order/whitespace on write, so
-- re-serializing a jsonb column on read produces a different string than
-- the one hashed at write time, permanently breaking verifyAuditChain()
-- for any multi-key payload. Store the exact JSON string that was hashed
-- instead.
ALTER TABLE "AuditLog" ALTER COLUMN "payload" TYPE TEXT USING "payload"::text;
