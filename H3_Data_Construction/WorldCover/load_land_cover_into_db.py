"""
load_land_cover_into_db.py
──────────────────────────
Reads ESA WorldCover GeoTIFF, samples each H3 cell that already exists in
the `base` table, computes the dominant land-cover class and full class
distribution, then upserts into the `land_cover` table.

Schema targeted:
    land_cover(h3_index, dominant_class, class_count, class_json, updated_at)

    dominant_class  – WorldCover class code as TEXT (e.g. "10", "50")
    class_count     – pixel count for the dominant class
    class_json      – JSONB with counts for every class present in the cell
                      e.g. {"10": 312, "50": 88}

Prerequisites:
    • base table populated (run load_base_into_db.py first)
    • ESA WorldCover .tif placed in the Data/ subdirectory

WorldCover class codes:
    10  Tree cover          20  Shrubland           30  Grassland
    40  Cropland            50  Built-up             60  Bare / sparse veg
    70  Snow / ice          80  Permanent water      90  Herbaceous wetland
    95  Mangroves          100  Moss / lichen
"""

import json
import os
import logging
from pathlib import Path
from collections import Counter

import h3
import numpy as np
import psycopg2
from psycopg2.extras import execute_batch
import rasterio
from rasterio.mask import mask as rasterio_mask
from shapely.geometry import mapping, shape

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

BATCH_SIZE   = 500
NODATA_VALUE = 0       # WorldCover nodata / unclassified
H3_RESOLUTION = int(os.getenv("H3_RESOLUTION", 9))

DATA_DIR     = Path(__file__).parent / "Data"
POLYGON_PATH = Path(__file__).parent.parent / "polygon.json"

# Pick the first .tif that contains "Map" in its name; adjust if needed.
def find_tif(data_dir: Path) -> Path:
    candidates = sorted(data_dir.glob("**/*Map*.tif"))
    if not candidates:
        candidates = sorted(data_dir.glob("**/*.tif"))
    if not candidates:
        raise FileNotFoundError(f"No .tif file found under {data_dir}")
    return candidates[0]


# ── H3 helpers ────────────────────────────────────────────────────────────

def cell_boundary_as_shapely(cell: str):
    """Return the H3 cell boundary as a Shapely Polygon (lng, lat coords)."""
    try:
        verts = h3.cell_to_boundary(cell)           # h3-py v4: returns [(lat,lng),...]
    except AttributeError:
        verts = h3.h3_to_geo_boundary(cell)         # h3-py v3

    # shapely expects (lng, lat)
    coords = [(lng, lat) for lat, lng in verts]
    coords.append(coords[0])   # close ring
    from shapely.geometry import Polygon
    return Polygon(coords)


# ── Raster helpers ────────────────────────────────────────────────────────

def sample_raster_for_cell(src, cell_poly_geom: dict) -> np.ndarray:
    """
    Clip raster to cell geometry and return a flat array of valid pixel values.
    Returns an empty array if the cell falls outside the raster extent.
    """
    try:
        out_image, _ = rasterio_mask(src, [cell_poly_geom], crop=True, nodata=NODATA_VALUE)
        pixels = out_image.flatten()
        return pixels[pixels != NODATA_VALUE]
    except Exception:
        return np.array([], dtype=np.uint8)


def dominant_class_and_counts(pixels: np.ndarray) -> tuple[str | None, int, dict]:
    """
    Return (dominant_class_str, dominant_count, class_distribution_dict).
    """
    if len(pixels) == 0:
        return None, 0, {}

    counter = Counter(pixels.tolist())
    dominant_val, dominant_count = counter.most_common(1)[0]
    class_json = {str(k): int(v) for k, v in counter.items()}

    return str(dominant_val), int(dominant_count), class_json


# ── Main ──────────────────────────────────────────────────────────────────

def main():
    tif_path = find_tif(DATA_DIR)
    log.info("Using raster: %s", tif_path)

    log.info("Connecting to database …")
    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = False

    # Fetch all h3_index values from base table
    with conn.cursor() as cur:
        cur.execute("SELECT h3_index FROM base")
        base_cells = [row[0] for row in cur.fetchall()]

    log.info("Found %d cells in base table", len(base_cells))
    if not base_cells:
        log.warning("base table is empty — run load_base_into_db.py first.")
        conn.close()
        return

    rows = []
    skipped = 0

    with rasterio.open(tif_path) as src:
        # Ensure CRS is WGS84
        if src.crs and src.crs.to_epsg() != 4326:
            log.warning(
                "Raster CRS is %s, not EPSG:4326. "
                "Results may be inaccurate — consider reprojecting the raster.",
                src.crs,
            )

        log.info("Sampling %d H3 cells from raster …", len(base_cells))

        for i, cell in enumerate(base_cells):
            if i % 5000 == 0 and i > 0:
                log.info("  … processed %d / %d", i, len(base_cells))

            cell_poly   = cell_boundary_as_shapely(cell)
            cell_geom   = mapping(cell_poly)
            pixels      = sample_raster_for_cell(src, cell_geom)

            dominant_class, class_count, class_json = dominant_class_and_counts(pixels)

            if dominant_class is None:
                skipped += 1
                continue

            rows.append((
                cell,
                dominant_class,
                class_count,
                json.dumps(class_json),
            ))

    log.info(
        "Sampling complete — %d rows to upsert, %d cells skipped (no data).",
        len(rows), skipped,
    )

    try:
        with conn.cursor() as cur:
            execute_batch(
                cur,
                """
                INSERT INTO land_cover (h3_index, dominant_class, class_count, class_json)
                VALUES (%s, %s, %s, %s::jsonb)
                ON CONFLICT (h3_index) DO UPDATE SET
                    dominant_class = EXCLUDED.dominant_class,
                    class_count    = EXCLUDED.class_count,
                    class_json     = EXCLUDED.class_json,
                    updated_at     = now()
                """,
                rows,
                page_size=BATCH_SIZE,
            )
        conn.commit()
        log.info("Done — %d rows upserted into land_cover.", len(rows))
    except Exception:
        conn.rollback()
        log.exception("Upsert failed, transaction rolled back.")
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
