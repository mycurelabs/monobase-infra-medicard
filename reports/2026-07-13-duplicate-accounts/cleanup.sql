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
-- Safety:  Wrapped in a single transaction. Idempotent (safe to re-run;
--          rows already moved to archive won't be reprocessed thanks to
--          ON CONFLICT DO NOTHING + the accounts DELETE only hitting rows
--          that still exist). All MERGE ref-remaps use a dynamically
--          discovered set of uid-ref columns via information_schema —
--          scan the NOTICE output for surprises before committing.
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
-- 2a. ARCHIVE — 13 rows (12 only-one-active ghosts + 1 both-dormant loser)
--     Refs (if any) will be remapped in the same style as MERGE (step 2b)
--     before deletion. For pure ghosts with 0 refs, remap is a no-op.
--     The remap target is the STAY uid of the same pair (canonical row).
-- ----------------------------------------------------------------------------
\echo ''
\echo '=== 2a. ARCHIVE + remap refs to canonical ==='

DO $$
DECLARE
  archive_row record;
  ref record;
  updated bigint;
BEGIN
  FOR archive_row IN (
    SELECT * FROM (VALUES
      -- (loser_uid, canonical_uid, label)
      ('63ab8ea69ab43bbf043b1e9d', '63ab8ef593f65f24137115e8', 'ghost:cebu.laboratory'),
      ('691a5b5b83d6bfc2a520426a', '5de7f76f4a1e9664a169bdf2', 'ghost:janemsalvadormd'),
      ('63b510af9e913c883a761026', '63b51078ae14ce5dd22be68e', 'both-dormant:jdumanat'),
      ('60ebe7f1c9081d9a6a0f1175', '5e26da232cbe6df829a71ce0', 'ghost:jeesleyer'),
      ('634f65d8e1954f9c41b67ad8', '62613cdde134b34c03307f0a', 'ghost:katrina_saliba'),
      ('65a1da869cd5f0ab9c55cc13', '64057528f4fbfa3509ae29cc', 'ghost:kristynellebonifacio'),
      ('67998d3923368a7bec0d88e3', '67997163f5e89cfc05386b19', 'ghost:mjcolong'),
      ('67bec9358ffa72306879e933', '66c5290cb20892255409836b', 'ghost:nmenricoso'),
      ('63ae8277dfcbb590380dfdcc', '63b369d45305734e1c67ce73', 'ghost:rdimanlig'),
      ('5de7f8dfc7650f648dc8c22e', '5df703c620e6f3187cdcdef1', 'ghost:regisyfu17'),
      ('62454741e134b34c03cdac4f', '5de7f8e887f4626497997f25', 'ghost:ritche_go'),
      ('6957114b9d1edc4832a3cc77', '68916027256d810a58cc3ee1', 'ghost:rtan'),
      ('5de7f924fd1696648383c135', '5de7f92587f4626497997f35', 'ghost:tanmyro')
    ) AS a(loser_uid, canonical_uid, label)
  )
  LOOP
    FOR ref IN
      SELECT table_schema, table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type = 'text'
        AND (column_name ~ '(_by|_uid|_account|_id)$'
             OR column_name IN ('account','user_id','owner_id','actor_id','actor','creator_account'))
        AND table_name NOT IN ('accounts','accounts_archive')
    LOOP
      EXECUTE format(
        'UPDATE %I.%I SET %I = $1 WHERE %I = $2',
        ref.table_schema, ref.table_name, ref.column_name, ref.column_name
      ) USING archive_row.canonical_uid, archive_row.loser_uid;
      GET DIAGNOSTICS updated = ROW_COUNT;
      IF updated > 0 THEN
        RAISE NOTICE 'archive-remap %: %.% -> % rows',
          archive_row.label, ref.table_name, ref.column_name, updated;
      END IF;
    END LOOP;

    INSERT INTO accounts_archive
      SELECT a.*, now(), archive_row.label
      FROM accounts a
      WHERE a.uid = archive_row.loser_uid
      ON CONFLICT (uid) DO NOTHING;

    DELETE FROM accounts WHERE uid = archive_row.loser_uid;
    IF FOUND THEN
      RAISE NOTICE 'archived: % (uid %)', archive_row.label, archive_row.loser_uid;
    END IF;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 2b. MERGE — 5 both-active pairs: remap refs from loser to canonical, then
--     archive the loser row with a `dup:merged-into:<canonical>` reason.
-- ----------------------------------------------------------------------------
\echo ''
\echo '=== 2b. MERGE + remap refs to canonical ==='

DO $$
DECLARE
  merge_row record;
  ref record;
  updated bigint;
BEGIN
  FOR merge_row IN (
    SELECT * FROM (VALUES
      -- (loser_uid, canonical_uid, label)
      ('5de7f7044a1e9664a169bdd0', '65263dd3476ce9229ce15c33', 'merge:eembudo'),
      ('639ac1bc7e95a230afe7f620', '63856a5579627c1bab4e1b48', 'merge:ferlylapinig'),
      ('66aadc9379b8c659f016a3ca', '66d7ae433a113b6af8213d44', 'merge:jazapico'),
      ('5de7f7b2c7650f648dc8c1d4', '63ca543838c7e84db3e9655a', 'merge:jrramirez'),
      ('60f7c7ac7590b24c0030af77', '68d9c7e1d43ba7878b67468d', 'merge:srmorito')
    ) AS m(loser_uid, canonical_uid, label)
  )
  LOOP
    FOR ref IN
      SELECT table_schema, table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type = 'text'
        AND (column_name ~ '(_by|_uid|_account|_id)$'
             OR column_name IN ('account','user_id','owner_id','actor_id','actor','creator_account'))
        AND table_name NOT IN ('accounts','accounts_archive')
    LOOP
      EXECUTE format(
        'UPDATE %I.%I SET %I = $1 WHERE %I = $2',
        ref.table_schema, ref.table_name, ref.column_name, ref.column_name
      ) USING merge_row.canonical_uid, merge_row.loser_uid;
      GET DIAGNOSTICS updated = ROW_COUNT;
      IF updated > 0 THEN
        RAISE NOTICE 'merge-remap %: %.% -> % rows',
          merge_row.label, ref.table_name, ref.column_name, updated;
      END IF;
    END LOOP;

    INSERT INTO accounts_archive
      SELECT a.*, now(), 'dup:merged-into:' || merge_row.canonical_uid
      FROM accounts a
      WHERE a.uid = merge_row.loser_uid
      ON CONFLICT (uid) DO NOTHING;

    DELETE FROM accounts WHERE uid = merge_row.loser_uid;
    IF FOUND THEN
      RAISE NOTICE 'merged: % (uid %) -> canonical %',
        merge_row.label, merge_row.loser_uid, merge_row.canonical_uid;
    END IF;
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
-- 4. Unique index rebuild — commented DDL for MediCard to review + run
--    after committing this script (or let migration 0054 create it fresh).
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
