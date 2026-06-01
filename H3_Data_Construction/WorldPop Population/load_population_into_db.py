"""
load_population_into_db.py
──────────────────────────
Reads the WorldPop 100m population raster, sums population pixels within
each H3 cell that exists in the `base` table, and upserts the result into
the `population` table.

Schema targeted:
    population(h3_index, population, updated_at)

    population  – total estimated population count (BIGINT)
                  calculated as the sum of all pixel values in the cell
                  (WorldPop raster stores fractional people per pixel;
                   values are rounded to the nearest integer)

Prerequisites:
    • base table populated (run load_base_into_db.py first)
    • WorldPop .tif placed in the Data/ subdirectory

WorldPop dataset:
    WorldPop 100m UN-adjusted unconstrained global mosaic — India
    Download: https://www.worldpop.org/geodata/listing?id=29
"""

import json
import os
import logging
from pathlib import Path

import h3
import numpy as np
import psycopg2
from psycopg2.extras import execute_batch
import rasterio
from rasterio.mask import mask as rasterio_mask
from shapely.geometry import mapping

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

BATCH_SIZE    = 500
NODATA_CUTOFF = 0.0     # WorldPop nodata is typically -99999 or 0; adjust if needed

DATA_DIR      = Path(__file__).parent / "Data"
POLYGON_PATH  = Path(__file__).parent.parent / "polygon.json"


def find_tif(data_dir: Path) -> Path:
    candidates = sorted(data_dir.glob("**/*.tif"))
    if not candidates:
        raise FileNotFoundError(f"No .tif file found under {data_dir}")
    return candidates[0]


# ── H3 helpers ────────────────────────────────────────────────────────────

def cell_boundary_as_shapely(cell: str):
    try:
        verts = h3.cell_to_boundary(cell)           # h3-py v4
    except AttributeError:
        verts = h3.h3_to_geo_boundary(cell)         # h3-py v3

    coords = [(lng, lat) for lat, lng in verts]
    coords.append(coords[0])
    from shapely.geometry import Polygon
    return Polygon(coords)


# ── Raster helpers ────────────────────────────────────────────────────────

def sample_population_for_cell(src, cell_geom: dict) -> int:
    """
    Sum all positive pixel values within the cell boundary.
    Returns 0 if the cell is outside the raster or has no valid pixels.
    """
    try:
        out_image, _ = rasterio_mask(
            src, [cell_geom], crop=True, nodata=src.nodata if src.nodata else -99999
        )
        pixels = out_image.flatten().astype(float)
        # Keep only plausible population values (> 0)
        valid  = pixels[pixels > NODATA_CUTOFF]
        return int(round(float(np.sum(valid)))) if len(valid) > 0 else 0
    except Exception:
        return 0


# ── Main ──────────────────────────────────────────────────────────────────

def main():
    tif_path = find_tif(DATA_DIR)
    log.info("Using raster: %s", tif_path)

    log.info("Connecting to database …")
    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = False

    with conn.cursor() as cur:
        cur.execute("SELECT h3_index FROM base")
        base_cells = [row[0] for row in cur.fetchall()]

    log.info("Found %d cells in base table", len(base_cells))
    if not base_cells:
        log.warning("base table is empty — run load_base_into_db.py first.")
        conn.close()
        return

    rows    = []
    skipped = 0

    with rasterio.open(tif_path) as src:
        if src.crs and src.crs.to_epsg() != 4326:
            log.warning(
                "Raster CRS is %s, not EPSG:4326. "
                "Results may be inaccurate — consider reprojecting the raster.",
                src.crs,
            )

        log.info("Sampling population for %d H3 cells …", len(base_cells))

        for i, cell in enumerate(base_cells):
            if i % 5000 == 0 and i > 0:
                log.info("  … processed %d / %d", i, len(base_cells))

            cell_poly   = cell_boundary_as_shapely(cell)
            cell_geom   = mapping(cell_poly)
            population  = sample_population_for_cell(src, cell_geom)

            if population == 0:
                skipped += 1
                # Still upsert zero-population cells so every base cell
                # has a corresponding population row (avoids NULL in h3_grids).

            rows.append((cell, population))

    log.info(
        "Sampling complete — %d rows to upsert (%d with zero population).",
        len(rows), skipped,
    )

    try:
        with conn.cursor() as cur:
            execute_batch(
                cur,
                """
                INSERT INTO population (h3_index, population)
                VALUES (%s, %s)
                ON CONFLICT (h3_index) DO UPDATE SET
                    population = EXCLUDED.population,
                    updated_at = now()
                """,
                rows,
                page_size=BATCH_SIZE,
            )
        conn.commit()
        log.info("Done — %d rows upserted into population.", len(rows))
    except Exception:
        conn.rollback()
        log.exception("Upsert failed, transaction rolled back.")
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
