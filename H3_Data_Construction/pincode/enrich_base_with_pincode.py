"""
enrich_base_with_pincode.py
───────────────────────────
Spatial join: for every H3 cell in the `base` table, find the polygon boundary
whose polygon contains the cell centre (lat/long) and write back:
    base.pincode  ← polygons."Pincode"
    base.circle   ← polygons."Circle"
    base.city     ← polygons.<office/district column>
    base.state    ← polygons.<state column>

The trg_after_base_upsert trigger automatically propagates every UPDATE to
the h3_grids table, so no direct write to h3_grids is needed.

Run AFTER:
    1. load_base_into_db.py   (base table populated)
    2. kml_to_db.py           (polygons table populated)
"""

import os
import logging
import psycopg2
from psycopg2.extras import execute_batch

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

DB_CONFIG = {
    "host":     os.getenv("DB_HOST",     "localhost"),
    "port":     int(os.getenv("DB_PORT", 5432)),
    "dbname":   os.getenv("DB_NAME",     "geointel_local"),
    "user":     os.getenv("DB_USER",     "postgres"),
    "password": os.getenv("DB_PASSWORD", "password"),
}

BATCH_SIZE = 500


def detect_columns(cur):
    """
    Return the actual column names from polygons for office/city and state,
    since different KMZ sources use different naming conventions.
    """
    cur.execute("""
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'polygons'
        ORDER BY ordinal_position
    """)
    cols = [r[0] for r in cur.fetchall()]
    log.info("polygons columns: %s", cols)

    # City / office name — prefer OfficeName, then office_name, then DistrictName
    city_col = next(
        (c for c in cols if c.lower() in ('officename', 'office_name', 'districtname', 'district_name')),
        None
    )
    # State — prefer StateName, then state_name, then State
    state_col = next(
        (c for c in cols if c.lower() in ('statename', 'state_name', 'state')),
        None
    )
    log.info("Using city column:  %s", city_col or "(none)")
    log.info("Using state column: %s", state_col or "(none)")
    return city_col, state_col


def main():
    log.info("Connecting to database …")
    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = False

    try:
        with conn.cursor() as cur:

            # ── Sanity checks ────────────────────────────────────────────
            cur.execute("SELECT COUNT(*) FROM base")
            base_count = cur.fetchone()[0]
            log.info("base table has %d rows", base_count)
            if base_count == 0:
                log.error("base table is empty — run load_base_into_db.py first")
                return

            cur.execute("SELECT COUNT(*) FROM polygons")
            pb_count = cur.fetchone()[0]
            log.info("polygons table has %d rows", pb_count)
            if pb_count == 0:
                log.error("polygons is empty — run kml_to_db.py first")
                return

            city_col, state_col = detect_columns(cur)

            # ── Build the UPDATE query ────────────────────────────────────
            # Uses ST_Within to match each H3 cell centre to a pincode polygon.
            # DISTINCT ON (b.h3_index) ensures one match per cell even if borders overlap.
            city_expr  = f'pb."{city_col}"'  if city_col  else "NULL"
            state_expr = f'pb."{state_col}"' if state_col else "NULL"

            update_sql = f"""
                UPDATE base AS b
                SET
                    pincode = pb."Pincode"::bigint,
                    circle  = pb."Circle",
                    city    = {city_expr},
                    state   = {state_expr},
                    updated_at = now()
                FROM (
                    SELECT DISTINCT ON (b2.h3_index)
                        b2.h3_index,
                        pb2."Pincode",
                        pb2."Circle"
                        {', pb2."' + city_col  + '"' if city_col  else ''}
                        {', pb2."' + state_col + '"' if state_col else ''}
                    FROM base b2
                    JOIN polygons pb2
                        ON ST_Within(
                            ST_SetSRID(ST_MakePoint(b2.long::float8, b2.lat::float8), 4326),
                            pb2.geometry
                        )
                    ORDER BY b2.h3_index
                ) AS pb(h3_index, "Pincode", "Circle"
                        {', "' + city_col  + '"' if city_col  else ''}
                        {', "' + state_col + '"' if state_col else ''}
                )
                WHERE b.h3_index = pb.h3_index
            """

            log.info("Running spatial join (this may take a few minutes for large datasets) …")
            cur.execute(update_sql)
            updated = cur.rowcount
            conn.commit()
            log.info("Done — %d base rows enriched with pincode/circle data.", updated)

            # Report how many cells got matched
            cur.execute("SELECT COUNT(*) FROM base WHERE pincode IS NOT NULL")
            matched = cur.fetchone()[0]
            log.info("%d / %d cells have a pincode match (%.1f%%)",
                     matched, base_count, 100 * matched / base_count if base_count else 0)

    except Exception:
        conn.rollback()
        log.exception("Enrichment failed, transaction rolled back.")
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
