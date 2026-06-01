"""
load_points_into_db.py
──────────────────────
Inserts Points of Interest into the `points` table.
Safe to re-run — uses INSERT ... ON CONFLICT DO NOTHING so existing rows
are never duplicated.

Add new points to the POINTS list below and re-run to upsert.
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

# ── Points data ───────────────────────────────────────────────────────────────
# Each entry: (lat, long, category, name)
POINTS = [
    (18.501273, 73.872445, 'Food & Dining',    'Baskin Robbins'),
    (18.485788, 73.888585, 'Food & Dining',    'Starbucks Coffee'),
    (18.579129, 73.736383, 'Food & Dining',    'Subway'),
    (18.511066, 73.747048, 'Food & Dining',    'Meridian Ice Cream'),
    (18.597663, 73.903936, 'Shopping',         'Jockey'),
    (18.501134, 73.850618, 'Shopping',         'Peter England'),
    (18.562372, 73.916165, 'Shopping',         'Van Heusen'),
    (18.480282, 73.824962, 'Shopping',         'Bata'),
    (19.095436, 73.997801, 'Fuel',             'IOCL'),
    (18.683459, 73.688118, 'Fuel',             'HPCL'),
    (18.504513, 73.819778, 'Fuel',             'BPCL'),
    (18.531182, 73.853921, 'Fuel',             'Shell'),
    (18.590351, 73.843407, 'Health & Wellness','Apollo Pharmacy'),
    (18.518595, 73.832483, 'Health & Wellness','VLCC'),
    (18.491329, 73.849747, 'Health & Wellness','MedPlus'),
    (18.518627, 73.878173, 'Health & Wellness','Sugar Cosmetics'),
    (18.559548, 73.797665, 'Groceries',        'Star Bazaar'),
    (18.576639, 73.986625, 'Groceries',        'Reliance Smart Point'),
    (18.584301, 73.976166, 'Groceries',        'DMart'),
    (18.566215, 73.910661, 'Groceries',        'Reliance Fresh'),
    (18.509727, 73.812808, 'Electronics',      'Vijay Sales'),
    (18.620219, 73.804066, 'Electronics',      'Samsung'),
    (18.565788, 73.771297, 'Electronics',      'Croma'),
    (18.723280, 73.683050, 'Electronics',      'Unicorn Store'),
    (18.538033, 73.907905, 'Entertainment',    'PVR'),
    (18.526956, 73.877718, 'Entertainment',    'Inox'),
    (18.519634, 73.931392, 'Entertainment',    'Cinepolis'),
    (18.592783, 73.745275, 'Entertainment',    'E square'),
]

INSERT_SQL = """
    INSERT INTO points (lat, long, category, name)
    VALUES (%s, %s, %s, %s)
    ON CONFLICT DO NOTHING
"""


def main():
    log.info("Connecting to database …")
    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = False

    try:
        with conn.cursor() as cur:
            execute_batch(cur, INSERT_SQL, POINTS)
            conn.commit()
            log.info("Inserted / skipped %d points of interest.", len(POINTS))

            cur.execute("SELECT COUNT(*) FROM points")
            total = cur.fetchone()[0]
            log.info("points table now has %d rows total.", total)

    except Exception:
        conn.rollback()
        log.exception("Load failed, transaction rolled back.")
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
