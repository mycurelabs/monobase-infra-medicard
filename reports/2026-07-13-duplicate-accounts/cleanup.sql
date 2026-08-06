-- ============================================================================
-- Duplicate-accounts cleanup — Azure PG target (mpiazeppgdb0003)
--
-- Purpose: resolve the 18 case-variant email duplicate groups in the
--          `accounts` table so the currently-INVALID unique index
--          `accounts_email_lower_unique` can be recreated as valid, which
--          unblocks Drizzle migration `0054_accounts_email_lower_unique`
--          and lets hapihub complete startup.
--
-- Handoff: MediCard. This script is provided UNEXECUTED. Review the sheet
--          (actions.csv) alongside this file before running.
--
-- Default: DRY-RUN. Prints a change summary, then ROLLBACK.
--          Set `-v commit=true` on the psql invocation to persist:
--              psql "$DATABASE_URI" -v commit=true -f cleanup.sql
--          Any other value (including unset) rolls back.
--
-- Rollback (if you commit and later want a specific row back):
--          INSERT INTO accounts SELECT <original-cols>
--                FROM accounts_archive WHERE uid = '<uid>';
--          (accounts_archive extends `accounts` with archived_at/reason cols.)
--
-- Mongo caveat: this script does NOT touch Mongo. Mongo remains the migrator's
--          source of truth. If the hapihub-migrator runs again against a
--          Mongo instance that still holds the same 18 case-variant duplicate
--          documents, the dupes will be re-imported into PG and this cleanup
--          will need to run again. Clean Mongo on your side before re-enabling
--          the migrator, or accept the re-import.
--
-- Scope:   This script ONLY archives duplicate account rows. It does NOT
--          remap the ~100 uid-ref columns across 141 tables that may point at
--          the archived uids. Two reasons:
--            1. Migration 0054 only inspects the `accounts` table itself —
--               removing the duplicates is sufficient to make the invalid
--               `accounts_email_lower_unique` index rebuild successfully.
--            2. A dynamic ref-remap sweep is prohibitively slow against
--               unindexed large tables in this schema (activity_logs = 84M
--               rows; billing_items = 6.2M; billing_invoices = 2.9M — none
--               of the uid-ref columns have supporting indexes).
--          Consolidating downstream refs from the archived uids to the STAY
--          uid is a separate follow-up and is MediCard's data-integrity
--          decision. Audit-log tables (activity_logs) should arguably KEEP
--          the historical uid unchanged — the event happened, and rewriting
--          the actor is history revisionism. Billing/booking/consent tables
--          may need consolidation on a per-case basis.
--
-- Safety:  Wrapped in a single transaction. Idempotent (safe to re-run;
--          rows already moved to archive won't be reprocessed thanks to
--          ON CONFLICT DO NOTHING + the accounts DELETE only hitting rows
--          that still exist).
-- ============================================================================

\set ON_ERROR_STOP on
\if :{?commit} \else \set commit false \endif

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Archive table (schema-preserving; created only if missing)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts_archive (LIKE accounts INCLUDING ALL);
ALTER TABLE accounts_archive
  ADD COLUMN IF NOT EXISTS archived_at   timestamp without time zone NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS archive_reason text;

\echo '=== accounts_archive prepared ==='

-- ----------------------------------------------------------------------------
-- 2. Archive all 18 loser rows in a single set-based INSERT + DELETE.
--    Reason strings encode:
--       ghost:<pair-label>        — only-one-active loser (12 rows)
--       both-dormant:<pair-label> — both-dormant loser  (1 row)
--       merge:<canonical-uid>     — both-active loser   (5 rows)
--    MediCard can query accounts_archive by reason for per-shape audit.
-- ----------------------------------------------------------------------------

\echo ''
\echo '=== 2. Archive losers ==='

DO $$
DECLARE
  loser record;
  archived int := 0;
  deleted int := 0;
BEGIN
  FOR loser IN (
    SELECT * FROM (VALUES
      -- 13 ARCHIVE (12 ghost + 1 both-dormant loser)
      ('63ab8ea69ab43bbf043b1e9d', 'ghost:cebu.laboratory'),
      ('691a5b5b83d6bfc2a520426a', 'ghost:janemsalvadormd'),
      ('63b510af9e913c883a761026', 'both-dormant:jdumanat'),
      ('60ebe7f1c9081d9a6a0f1175', 'ghost:jeesleyer'),
      ('634f65d8e1954f9c41b67ad8', 'ghost:katrina_saliba'),
      ('65a1da869cd5f0ab9c55cc13', 'ghost:kristynellebonifacio'),
      ('67998d3923368a7bec0d88e3', 'ghost:mjcolong'),
      ('67bec9358ffa72306879e933', 'ghost:nmenricoso'),
      ('63ae8277dfcbb590380dfdcc', 'ghost:rdimanlig'),
      ('5de7f8dfc7650f648dc8c22e', 'ghost:regisyfu17'),
      ('62454741e134b34c03cdac4f', 'ghost:ritche_go'),
      ('6957114b9d1edc4832a3cc77', 'ghost:rtan'),
      ('5de7f924fd1696648383c135', 'ghost:tanmyro'),
      -- 5 MERGE (both-active losers; reason encodes the STAY canonical uid)
      ('5de7f7044a1e9664a169bdd0', 'merge:65263dd3476ce9229ce15c33'),  -- eembudo
      ('639ac1bc7e95a230afe7f620', 'merge:63856a5579627c1bab4e1b48'),  -- ferlylapinig
      ('66aadc9379b8c659f016a3ca', 'merge:66d7ae433a113b6af8213d44'),  -- jazapico
      ('5de7f7b2c7650f648dc8c1d4', 'merge:63ca543838c7e84db3e9655a'),  -- jrramirez
      ('60f7c7ac7590b24c0030af77', 'merge:68d9c7e1d43ba7878b67468d')   -- srmorito
    ) AS l(uid, reason)
  )
  LOOP
    WITH ins AS (
      INSERT INTO accounts_archive
        SELECT a.*, now(), loser.reason
        FROM accounts a WHERE a.uid = loser.uid
        ON CONFLICT (uid) DO NOTHING
        RETURNING 1
    )
    SELECT count(*) INTO STRICT archived FROM ins;

    WITH del AS (
      DELETE FROM accounts WHERE uid = loser.uid RETURNING 1
    )
    SELECT count(*) INTO STRICT deleted FROM del;

    RAISE NOTICE 'loser % (%): archived=% deleted=%',
      loser.uid, loser.reason, archived, deleted;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 3. Post-check: no case-insensitive email dupes should remain
-- ----------------------------------------------------------------------------
\echo ''
\echo '=== 3. Verify no dupes remain ==='

DO $$
DECLARE remaining int;
BEGIN
  SELECT count(*) INTO remaining FROM (
    SELECT lower(email) FROM accounts
    WHERE email IS NOT NULL AND email <> ''
    GROUP BY lower(email) HAVING count(*) > 1
  ) t;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'unresolved dupes remain: % groups', remaining;
  END IF;
  RAISE NOTICE 'OK: 0 case-insensitive email dupes in accounts';
END $$;

-- ----------------------------------------------------------------------------
-- 4. Unique index rebuild — commented DDL for MediCard to run separately.
--    Note: CREATE UNIQUE INDEX CONCURRENTLY cannot run inside a transaction
--    block, so it stays out of this script.
--
--    DROP INDEX IF EXISTS accounts_email_lower_unique;
--    CREATE UNIQUE INDEX CONCURRENTLY accounts_email_lower_unique
--      ON accounts (lower(email))
--      WHERE email IS NOT NULL AND email <> '';
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 5. Commit / rollback
-- ----------------------------------------------------------------------------
\echo ''
\if :commit
  \echo '=== COMMIT MODE — persisting changes ==='
  COMMIT;
\else
  \echo '=== DRY RUN — rolling back (run with -v commit=true to persist) ==='
  ROLLBACK;
\endif
