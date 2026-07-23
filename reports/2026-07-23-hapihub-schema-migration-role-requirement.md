# hapihub PostgreSQL schema-migration role — ownership requirement

**Date:** 2026-07-23
**System:** hapihub PostgreSQL schema — Azure Flexible Server `mpiazeppgdb0003`, database `medicard-production`

> **Ask (one line):** the DB role hapihub uses must **own** (or be a member of the owner of) the hapihub tables, so hapihub can run its own schema migrations and (re)install its triggers.

---

## 1. Why hapihub needs this

hapihub self-manages its PostgreSQL schema — DDL is applied at process start via `installAuditTrigger()` and the `services/hapihub/drizzle-pg/*.sql` migration set. PostgreSQL restricts these operations to the **object owner** (or a role that is a member of the owner):

- `ALTER TABLE …` (constraints, columns, primary keys)
- `CREATE OR REPLACE FUNCTION` / trigger management

If the role hapihub connects with is not the owner, hapihub silently cannot advance its own schema, and its migrations stay unapplied while the deployed code expects them.

## 2. The gap on `medicard-production`

| | |
|---|---|
| Owner of hapihub tables (`medical_records`, `personal_details`, `*_history`, …) | **`mpadmin02`** (an Azure admin login) |
| Role hapihub connects with (same `DATABASE_URI`, per `values/deployments/medicard.yaml`) | **`mycure_prod_app`** |
| `mycure_prod_app` attributes | `rolsuper = f`; **member of `azure_pg_admin`**; **not a member of `mpadmin02`** (`pg_has_role(…,'mpadmin02','MEMBER') = f`) |
| Result | hapihub cannot run schema DDL against these tables |

`mycure_prod_app` **does** have DDL rights on schemas it *owns* — e.g. Cadence's `cadence` schema (`ensure_sync_infra` installs its triggers/indexes at boot, "needs DDL rights, which `mycure_prod_app` has via `azure_pg_admin`"). Ownership is per-object, though: the **hapihub core + history tables are owned by `mpadmin02`, not `mycure_prod_app`**, so `azure_pg_admin` membership does not confer these owner-only rights. Confirmed empirically — `SET session_replication_role = replica` and an `ALTER TABLE` against these tables are both denied for `mycure_prod_app`.

## 3. Recommended change

Give hapihub's role owner-level access. Executed once by an admin (`mpadmin02` / Azure portal), in order of preference:

1. **Reassign ownership of the hapihub tables to `mycure_prod_app`** — matches the model already used for Cadence (the app role owns its own schema and self-manages DDL). One-time, by the owner:
   ```sql
   ALTER TABLE <table> OWNER TO mycure_prod_app;   -- each hapihub-managed table (+ its sequences)
   ```
   Scope first — list what `mpadmin02` owns so the target set is known (and to confirm a `REASSIGN OWNED BY mpadmin02 TO mycure_prod_app;` wouldn't sweep in non-hapihub objects):
   ```sql
   SELECT relkind, relname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
   WHERE r.rolname = 'mpadmin02' AND relkind IN ('r','S') ORDER BY 1,2;
   ```
   After this, hapihub applies its own migrations going forward — no ongoing admin involvement.
2. **Make the app/migration role a member of the owner:** `GRANT mpadmin02 TO mycure_prod_app;`. Simplest, but keeps ownership on a human admin login.
3. **Run hapihub migrations under a dedicated migration credential** that owns the schema (distinct from the runtime app role).

Align the choice with the existing Azure Flexible Server admin model.
