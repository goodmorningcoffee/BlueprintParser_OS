-- [refactor jun13 P0.5-G2] chat_messages.project_id nullable: NULL = global
-- (cross-project) chat. Global chat used to insert projectId=0 → FK violation
-- after the response had fully streamed → history silently lost.
--
-- NOTE: drizzle's meta snapshot had been stale since ~0025 (0026-0031 were
-- hand-written without snapshot updates), so `drizzle-kit generate` emitted
-- all of that old DDL into this file too. It already shipped in 0026-0031 and
-- was removed from here; 0032's meta snapshot now matches schema.ts, so
-- future generates diff cleanly.
ALTER TABLE "chat_messages" ALTER COLUMN "project_id" DROP NOT NULL;
