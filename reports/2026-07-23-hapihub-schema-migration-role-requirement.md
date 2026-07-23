# hapihub PostgreSQL schema-migration role — ownership requirement

**Date:** 2026-07-23
**System:** hapihub PostgreSQL schema — Azure Flexible Server `mpiazeppgdb0003`, database `medicard-production`
**Severity:** High — a pending hapihub schema migration cannot be applied, and the resulting drift will fail record updates once traffic runs on PostgreSQL.

> **Ask (one line):** the DB role hapihub uses to run its own schema migrations must **own** (or be a member of the owner of) the hapihub tables, so hapihub can apply the pending `0010_history_pk_swap` migration and (re)install `audit_trigger_fn`.

---

## 1. Why hapihub needs this

hapihub manages its PostgreSQL schema itself — DDL is applied at process start via `installAuditTrigger()` and the `services/hapihub/drizzle-pg/*.sql` migration set. PostgreSQL restricts the operations these migrations perform to the **object owner** (or a role that is a member of the owner):

- `ALTER TABLE … ADD/DROP CONSTRAINT` (primary-key changes)
- `ALTER TABLE … ALTER COLUMN … DROP NOT NULL`
- `CREATE OR REPLACE FUNCTION` / trigger management

If the role hapihub connects with is not the owner, hapihub silently cannot advance its own schema, and the deployed code drifts from the actual database.

## 2. The gap on `medicard-production`

| | |
|---|---|
| Owner of hapihub tables (`medical_records`, `personal_details`, `*_history`, …) | **`mpadmin02`** (an Azure admin login) |
| Role hapihub connects with (same `DATABASE_URI`, per `values/deployments/medicard.yaml`) | **`mycure_prod_app`** |
| `mycure_prod_app` attributes | `rolsuper = f`; **member of `azure_pg_admin`**; **not a member of `mpadmin02`** (`pg_has_role(…,'mpadmin02','MEMBER') = f`) |
| Result | hapihub cannot run schema DDL against these tables |

Nuance worth stating up front: `mycure_prod_app` **does** have DDL rights on schemas it *owns* — e.g. Cadence's `cadence` schema (`ensure_sync_infra` installs its triggers/indexes at boot, "needs DDL rights, which `mycure_prod_app` has via `azure_pg_admin`"). Ownership is per-object, though: the **hapihub core + history tables are owned by `mpadmin02`, not `mycure_prod_app`**, so `azure_pg_admin` membership does not confer the owner-only rights below. Confirmed empirically — `SET session_replication_role = replica` and an `ALTER TABLE` against these tables are both denied for `mycure_prod_app`.

Because of this, hapihub's **`0010_history_pk_swap`** migration has **never been applied to prod**. It is meant to flip every `*_history` primary key from `_record` → `id` (so `id` is the unique per-entry id and `_record` becomes a non-unique FK to the source row), matching the in-code convention set in commit `1e786954`. Confirmed drift: `medical_records_history_pkey` is still `PRIMARY KEY (_record)`.

## 3. Why this is a go-live blocker (not just a migration nicety)

The deployed `audit_trigger_fn` already follows the **new** convention — on every `UPDATE`/`DELETE` it inserts a fresh random `id` and `OLD.id` into `_record`. Run against the **old** `_record`-PK schema, that write **collides on `_record`** for any record that already has a history row → the triggering `UPDATE` fails with `duplicate key … _history_pkey`.

Today this is masked because writes still go to the legacy source. **Once application traffic runs on PostgreSQL, any repeated update of a record that has history will error.** Resolving the drift is therefore a prerequisite for cutover.

## 4. What the migration will do (the owner-only DDL)

`0010_history_pk_swap`, per `*_history` table (`personal_details_history`, `diagnostic_order_tests_history`, `inventory_stocks_history`, `medical_records_history`):

```sql
ALTER TABLE "<t>_history" DROP CONSTRAINT "<t>_history_pkey";   -- drop _record PK
ALTER TABLE "<t>_history" ADD PRIMARY KEY ("id");
ALTER TABLE "<t>_history" ALTER COLUMN "_record" DROP NOT NULL;
-- + CREATE OR REPLACE FUNCTION audit_trigger_fn()  (at hapihub startup)
```

All are owner-only.

### Data prerequisite (approved) — dedupe before the PK swap

`ADD PRIMARY KEY ("id")` requires `id` to be unique. It currently is not; the migration header documents a manual dedupe (keep the latest entry per `id`). Current duplicate counts on prod:

| table | rows | duplicate `id`s |
|---|---|---|
| `personal_details_history` | 38,479,108 | 34,088,967 |
| `medical_records_history` | 17,613,692 | 311,290 |
| `diagnostic_order_tests_history` | 3,931,656 | 265,328 |
| `inventory_stocks_history` | 468,830 | 447,980 |

The dedupe destroys all but the latest audit entry per `id` (~35M rows). This has been accepted; still, before running: export the history tables to cold storage if the trail is needed for compliance, and run in a maintenance window (the `DELETE` holds row locks and takes minutes on the multi-GB tables). Per-table dedupe (from the migration header — the window form completed in <1 min where a `NOT IN` form ran 17 min without finishing):

```sql
WITH ranked AS (
  SELECT ctid, ROW_NUMBER() OVER (
    PARTITION BY id ORDER BY _h_created_at DESC NULLS LAST
  ) AS rn
  FROM "<table>_history"
)
DELETE FROM "<table>_history" t USING ranked r
WHERE t.ctid = r.ctid AND r.rn > 1;
```

## 5. Recommended change

Give hapihub's schema-migration path owner-level access. Executed once by an admin (`mpadmin02` / Azure portal), in order of preference:

1. **Reassign ownership of the hapihub tables to `mycure_prod_app`** — matches the model already used for Cadence (the app role owns its own schema and self-manages DDL). One-time, by the owner:
   ```sql
   ALTER TABLE medical_records            OWNER TO mycure_prod_app;
   ALTER TABLE medical_records_history    OWNER TO mycure_prod_app;
   -- … all hapihub-managed tables (and their sequences).
   ```
   Scope first — list what `mpadmin02` owns so the reassignment target is known (and to confirm `REASSIGN OWNED BY mpadmin02 TO mycure_prod_app;` wouldn't sweep in non-hapihub objects):
   ```sql
   SELECT relkind, relname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
   WHERE r.rolname = 'mpadmin02' AND relkind IN ('r','S') ORDER BY 1,2;
   ```
   After this, hapihub applies its own migrations going forward — no ongoing admin involvement.
2. **Make the app/migration role a member of the owner:** `GRANT mpadmin02 TO mycure_prod_app;`. Simplest, but keeps ownership on a human admin login.
3. **Run hapihub migrations under a dedicated migration credential** that owns the schema (distinct from the runtime app role).

After the role is in place **and** the dedupe is done, deploy a hapihub version that includes `0010_history_pk_swap` (or apply it manually as the owner). `audit_trigger_fn` is `CREATE OR REPLACE`'d at hapihub startup, so no separate trigger step is needed.

## 6. Sequence to resolution

1. Grant hapihub's migration role ownership/membership (§5).
2. Export `*_history` (if required) → run the documented dedupe (§4).
3. hapihub deploy applies `0010_history_pk_swap` (or apply manually as owner).
4. Verify: `*_history` PK is now `id`; a repeated `UPDATE` on a base row succeeds (no `_history_pkey` conflict).
