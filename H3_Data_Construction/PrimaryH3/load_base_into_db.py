"""
load_base_into_db.py
────────────────────
Generates H3 cells at resolution 9 for the region defined in polygon.json
and upserts them into the `base` table.

Schema targeted:
    base(h3_index, resolution, lat, long, pincode, city, state, updated_at)

pincode / city / state are left NULL here — populate them via a separate
enrichment step (e.g. spatial join against polygons) once the
base grid is loaded.

Run order:
    1. load_base_into_db.py          ← this file
    2. load_land_cover_into_db.py
    3. load_population_into_db.py
    4. load_urbanisation_into_db.py
"""

import json
import os
import logging
from pathlib import Path

import h3
import psycopg2
from psycopg2.extras import execute_batch

# ── Logging ───────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────
DB_CONFIG = {
    "host":     os.getenv("DB_HOST",     "localhost"),
    "port":     int(os.getenv("DB_PORT", 5432)),
    "dbname":   os.getenv("DB_NAME",     "geointel_local"),
    "user":     os.getenv("DB_USER",     "postgres"),
    "password": os.getenv("DB_PASSWORD", "password"),
}

H3_RESOLUTION = int(os.getenv("H3_RESOLUTION", 9))
BATCH_SIZE    = 500

POLYGON_PATH  = Path(__file__).parent.parent / "polygon.json"


# ── Helpers ───────────────────────────────────────────────────────────────

def load_polygon(path: Path) -> dict:
    """Return the GeoJSON polygon dict from polygon.json."""
    with open(path) as f:
        return json.load(f)


def polygon_to_latlng_tuples(geojson_polygon: dict) -> list[tuple[float, float]]:
    """
    Convert a GeoJSON Polygon's outer ring to a list of (lat, lng) tuples.
    polygon.json stores coordinates as [lng, lat] (GeoJSON spec) OR
    [lat, lng] depending on how it was authored.

    Current polygon.json uses [lat, lng] order — adjust the swap flag below
    if your file uses standard GeoJSON [lng, lat] order.
    """
    coords = geojson_polygon["coordinates"][0]

    # Detect order: if the first value looks like a longitude (>90 or <-90)
    # it is [lng, lat] and needs swapping.
    sample = coords[0]
    needs_swap = abs(sample[0]) > 90

    if needs_swap:
        return [(lat, lng) for lng, lat in coords]
    else:
        return [(lat, lng) for lat, lng in coords]


def generate_h3_cells(latlng_ring: list, resolution: int) -> list[str]:
    """
    Use h3.polygon_to_cells (h3-py v4) to fill the polygon.
    Falls back to h3.polyfill (h3-py v3) if v4 is not available.
    """
    try:
        # h3-py v4
        poly  = h3.LatLngPoly(latlng_ring)
        cells = list(h3.polygon_to_cells(poly, resolution))
    except AttributeError:
        # h3-py v3 fallback
        geojson = {
            "type": "Polygon",
            "coordinates": [[(lng, lat) for lat, lng in latlng_ring]],
        }
        cells = list(h3.polyfill(geojson, resolution, geo_json_conformant=True))

    return cells


def cell_to_latlng(cell: str) -> tuple[float, float]:
    """Return (lat, lng) centre of an H3 cell — works for v3 and v4."""
    try:
        return h3.cell_to_latlng(cell)          # h3-py v4
    except AttributeError:
        return h3.h3_to_geo(cell)               # h3-py v3


def get_resolution(cell: str) -> int:
    try:
        return h3.get_resolution(cell)          # h3-py v4
    except AttributeError:
        return h3.h3_get_resolution(cell)       # h3-py v3


# ── Main ──────────────────────────────────────────────────────────────────

def main():
    log.info("Loading polygon from %s", POLYGON_PATH)
    geojson_polygon = load_polygon(POLYGON_PATH)

    latlng_ring = polygon_to_latlng_tuples(geojson_polygon)
    log.info("Polygon has %d vertices", len(latlng_ring))

    log.info("Generating H3 cells at resolution %d …", H3_RESOLUTION)
    cells = generate_h3_cells(latlng_ring, H3_RESOLUTION)
    log.info("Generated %d cells", len(cells))

    # Build rows: (h3_index, resolution, lat, long)
    rows = []
    for cell in cells:
        lat, lng = cell_to_latlng(cell)
        res      = get_resolution(cell)
        rows.append((cell, res, float(lat), float(lng)))

    log.info("Connecting to database …")
    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = False

    try:
        with conn.cursor() as cur:
            log.info("Upserting %d rows into base …", len(rows))
            execute_batch(
                cur,
                """
                INSERT INTO base (h3_index, resolution, lat, long)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (h3_index) DO UPDATE SET
                    resolution = EXCLUDED.resolution,
                    lat        = EXCLUDED.lat,
                    long       = EXCLUDED.long,
                    updated_at = now()
                """,
                rows,
                page_size=BATCH_SIZE,
            )
        conn.commit()
        log.info("Done — %d rows upserted into base.", len(rows))
    except Exception:
        conn.rollback()
        log.exception("Upsert failed, transaction rolled back.")
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
