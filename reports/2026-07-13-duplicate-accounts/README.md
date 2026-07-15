# Duplicate accounts — findings, recommendations, and cleanup script

**Date:** 2026-07-13
**Target:** Azure PG `mpiazeppgdb0003` — `accounts` table
**Scope:** 18 case-variant email duplicate groups (36 rows) blocking migration `0054_accounts_email_lower_unique`
**Handoff:** MediCard executes the script; recommendations below are advisory

## Bottom line

The 18 duplicate `accounts` groups that block Drizzle migration `0054_accounts_email_lower_unique` are all case-variant email pairs — same person's email captured with different letter casing at different points in time. This bundle contains the artifacts to resolve them in PG: a per-row action recommendation sheet (13 ARCHIVE, 5 MERGE, 18 STAY) and a defensive PG script that defaults to dry-run. Nothing in this bundle mutates Mongo; if the hapihub-migrator is re-run against an un-cleaned Mongo source, the same 18 pairs re-import and the PG cleanup will need to be repeated.

## Files

| File | Purpose |
|---|---|
| [`actions.csv`](./actions.csv) | 36 rows (one per uid) with per-row `action` recommendation (STAY / ARCHIVE / MERGE-INTO-\<uid\>) and a one-line rationale. Open in Excel/Sheets and filter by `action` to bulk-review. |
| [`cleanup.sql`](./cleanup.sql) | psql script that applies the recommendations. Defaults to dry-run (BEGIN + ROLLBACK). Set `-v commit=true` to persist. |
| `README.md` | This file. |

## How to use

1. **Open `actions.csv`** in Excel / Google Sheets / Numbers. Sort or filter by `action`. Confirm every recommended STAY / ARCHIVE / MERGE choice aligns with your understanding of the accounts. If you want to override any row — flip the `action` column and edit the corresponding VALUES block in `cleanup.sql` before running.
2. **Dry-run the script:**
   ```bash
   psql "$DATABASE_URI" -f cleanup.sql
   ```
   Reads the `RAISE NOTICE` output — one line per uid-ref column that would be updated during MERGE / archive-remap. If any table you weren't expecting shows up, stop and investigate.
3. **Commit when satisfied:**
   ```bash
   psql "$DATABASE_URI" -v commit=true -f cleanup.sql
   ```
4. **Rebuild the unique index** (commented DDL in the script — run separately for zero-downtime `CONCURRENTLY`):
   ```sql
   DROP INDEX IF EXISTS accounts_email_lower_unique;
   CREATE UNIQUE INDEX CONCURRENTLY accounts_email_lower_unique
     ON accounts (lower(email)) WHERE email IS NOT NULL AND email <> '';
   ```
   Or leave the invalid index in place and let migration `0054` recreate it on next migrator boot.
5. **Rollback a specific row** (if you commit and later change your mind):
   ```sql
   INSERT INTO accounts SELECT <original-cols>
     FROM accounts_archive WHERE uid = '<uid>';
   ```
   The `accounts_archive` table extends `accounts` with `archived_at` and `archive_reason` columns.

## Findings

- **2,860 rows** in the PG `accounts` table (external Azure PG). Mongo has 2,954 for the same collection — the 94-row delta is a separate migrator gap not scoped here.
- **18 duplicate groups**, each exactly 2 rows. Every group is a case-variant of the same email address (e.g. `Kristynellebonifacio@gmail.com` vs `kristynellebonifacio@gmail.com`). No triple-collisions.
- **Root cause is in the source data**, not the migrator. The same 18 groups exist in Mongo with identical casings. Mongo has no case-insensitive uniqueness on `email` by default, so users and imports accumulated case-variant duplicates over ~5+ years.
- **Three pair shapes** emerged when we cross-referenced activity signal (last active, signin count, org memberships) between PG and Mongo:
  - **12 only-one-active pairs** — one uid has real signin history; the other has zero signins and never activated. Ghost-side is likely a re-registration attempt that failed silent case-mismatch matching.
  - **5 both-active pairs** — both uids have real signin history. `jrramirez@medicardphils.com` is the most extreme: one uid has 1,222 signins (active through 2023-10), the other has 12,985 signins (active through 2026-06). These are the same person using the account under two case variants over time.
  - **1 both-dormant pair** (`jdumanat@medicardphils.com`) — neither uid ever signed in. One has an org membership + onboarding progress, the other has neither.

## How the recommendations were derived

For each pair, we picked the canonical uid using this signal ranking (all signals sourced from Mongo since the PG copy is missing activity fields — see uncertainty note below):

1. **Non-zero signins beats zero signins.** Real usage always wins over never-used.
2. **If both non-zero:** most recent `last_active_at` wins. This is the account the user actually uses today, regardless of historical signin count.
3. **If both zero:** more `_og` (org memberships) beats fewer; then earlier `created_at` beats later.

The **canonical uid gets `STAY`**. The other uid gets:
- **`ARCHIVE`** for only-one-active and both-dormant losers — moved to `accounts_archive`, refs (if any) first remapped to the canonical uid.
- **`MERGE-INTO-<canonical-uid>`** for both-active losers — refs remapped to the canonical uid, then loser row moved to `accounts_archive`.

Under the hood, the script treats ARCHIVE and MERGE identically: dynamically discover all text-typed uid-ref columns via `information_schema.columns`, rewrite `loser_uid → canonical_uid`, then archive the loser. The CSV distinction is semantic — MediCard sees at a glance whether the loser was a ghost (no data to preserve) or an active user (data likely needs consolidation).

## Uncertainty — MediCard should scan for this

The MERGE / archive-remap step discovers uid-ref columns dynamically at runtime using a heuristic on column names:
- ends with `_by`, `_uid`, `_account`, `_id`
- OR is one of `account`, `user_id`, `owner_id`, `actor_id`, `actor`, `creator_account`

That covers the columns we spotted while investigating (roughly 100+ candidates across 141 tables), but the exhaustiveness depends on the regex being right. Any table with a uid-ref column that doesn't match those patterns will not have its refs remapped, and the archived row will effectively become an orphan reference.

**During dry-run, read the `RAISE NOTICE` output line by line.** Each line names a `<table>.<column>` that would be updated. If a table you know references accounts doesn't appear in the notices, the regex missed a column — extend it before committing.

## Mongo re-import caveat

This script fixes PG only. Mongo remains MediCard's source of truth and the hapihub-migrator's input. The migrator is currently paused (`replicaCount: 0`) and doesn't run on any schedule — but whenever it does run against a Mongo that still contains the same 18 case-variant duplicate documents, they will re-import into PG and this cleanup will need to run again.

Two options for closing the loop on MediCard's side:
1. **Clean Mongo first** using the same recommendations (mirrored in Mongo's `accounts` collection), then run this PG script or let the migrator re-sync from clean-Mongo → clean-PG.
2. **Accept the re-import** — run this PG script whenever needed, and script it into your migrator post-run playbook.

This is MediCard's decision — our team did not touch Mongo during the investigation (all queries were `readPreference=secondaryPreferred`, aggregate/find only).

## Separate concern — noted, not addressed here

While comparing PG and Mongo signals for the same 36 uids, we noticed that **PG shows every one of them as `signins_count = 0, last_active_at = NULL, updated_at = NULL`**, while Mongo shows values up to 12,985 signins. The migrator appears to drop the activity fields (`signinsCount`, `lastActiveAt`, `isEmailVerified`, `updatedAt`, `onboarding`, `credentials`, `_og`) during the Mongo → PG copy. That's a broader migrator-mapping gap, out of scope for this bundle but worth its own follow-up before hapihub relies on those fields in PG.

## What we did NOT do

- **Never mutated Mongo or PG.** All investigation queries were read-only:
  - PG: session opened with `SET default_transaction_read_only = on;` (verified via `SHOW default_transaction_read_only`)
  - Mongo: URI parameter `readPreference=secondaryPreferred`, aggregate/find operations only, no `insertOne`/`updateOne`/`deleteOne`/`bulkWrite`/`drop`
- **Did not sweep all 141 tables to enumerate every uid-ref column ahead of time.** The MERGE loop discovers them dynamically at execution time — the alternative (static hand-curated list) risked silent gaps. See the uncertainty note above.
- **Did not create a Mongo cleanup script.** Mongo access stays read-only.
- **Did not execute the PG script.** Handed over unexecuted with commit mode off by default.
