"""
load_urbanisation_into_db.py
─────────────────────────────
Reads the WorldPop Global Urban Density 2025 raster, samples the dominant
urbanisation class for each H3 cell in the `base` table, and upserts into
the `urbanisation` table.

⚠  Schema note
    migration.sql does not yet include an `urbanisation` table or a trigger
    to merge it into h3_grids.  Add the following to migration.sql before
    running this script:

    ── Add to migration.sql ──────────────────────────────────────────────

    CREATE TABLE urbanisation (
        h3_index      character varying(32) NOT NULL,
        urban_class   TEXT,
        class_count   BIGINT,
        class_json    JSONB,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT pk_urbanisation PRIMARY KEY (h3_index)
    );

    CREATE INDEX idx_urbanisation_updated ON urbanisation (updated_at);

    -- Add urbanisation columns to h3_grids
    ALTER TABLE h3_grids
        ADD COLUMN IF NOT EXISTS urban_class             TEXT,
        ADD COLUMN IF NOT EXISTS urban_class_count       BIGINT,
        ADD COLUMN IF NOT EXISTS urban_class_json        JSONB,
        ADD COLUMN IF NOT EXISTS urbanisation_updated_at TIMESTAMPTZ;

    -- Trigger: urbanisation → h3_grids
    CREATE OR REPLACE FUNCTION trg_merge_urbanisation()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
        INSERT INTO h3_grids (
            h3_index, urban_class, urban_class_count,
            urban_class_json, urbanisation_updated_at, last_modified_at
        )
        VALUES (
            NEW.h3_index, NEW.urban_class, NEW.class_count,
            NEW.class_json, NEW.updated_at, now()
        )
        ON CONFLICT (h3_index) DO UPDATE SET
            urban_class             = EXCLUDED.urban_class,
            urban_class_count       = EXCLUDED.urban_class_count,
            urban_class_json        = EXCLUDED.urban_class_json,
            urbanisation_updated_at = EXCLUDED.urbanisation_updated_at,
            last_modified_at        = now();
        RETURN NEW;
    END;
    $$;

    CREATE TRIGGER trg_after_urbanisation_upsert
    AFTER INSERT OR UPDATE ON urbanisation
    FOR EACH ROW EXECUTE FUNCTION trg_merge_urbanisation();

    ─────────────────────────────────────────────────────────────────────

WorldPop DUG 2025 urban class codes (L2):
    1  High-density urban (HDU)
    2  Low-density urban (LDU)
    3  Suburban / peri-urban
    4  Rural
    (exact codes depend on the specific product version)
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
NODATA_VALUE  = 0

DATA_DIR      = Path(__file__).parent / "Data"
POLYGON_PATH  = Path(__file__).parent.parent / "polygon.json"


def find_tif(data_dir: Path) -> Path:
    # Prefer the L2 grid raster
    candidates = sorted(data_dir.glob("**/*L2*.tif"))
    if not candidates:
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

def sample_raster_for_cell(src, cell_geom: dict) -> np.ndarray:
    try:
        out_image, _ = rasterio_mask(src, [cell_geom], crop=True, nodata=NODATA_VALUE)
        pixels = out_image.flatten()
        return pixels[pixels != NODATA_VALUE]
    except Exception:
        return np.array([], dtype=np.uint8)


def dominant_class_and_counts(pixels: np.ndarray) -> tuple:
    if len(pixels) == 0:
        return None, 0, {}
    counter      = Counter(pixels.tolist())
    dominant_val, dominant_count = counter.most_common(1)[0]
    class_json   = {str(k): int(v) for k, v in counter.items()}
    return str(dominant_val), int(dominant_count), class_json


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

        log.info("Sampling urbanisation class for %d H3 cells …", len(base_cells))

        for i, cell in enumerate(base_cells):
            if i % 5000 == 0 and i > 0:
                log.info("  … processed %d / %d", i, len(base_cells))

            cell_poly              = cell_boundary_as_shapely(cell)
            cell_geom              = mapping(cell_poly)
            pixels                 = sample_raster_for_cell(src, cell_geom)
            urban_class, count, cj = dominant_class_and_counts(pixels)

            if urban_class is None:
                skipped += 1
                continue

            rows.append((cell, urban_class, count, json.dumps(cj)))

    log.info(
        "Sampling complete — %d rows to upsert, %d cells skipped (no data).",
        len(rows), skipped,
    )

    try:
        with conn.cursor() as cur:
            execute_batch(
                cur,
                """
                INSERT INTO urbanisation (h3_index, urban_class, class_count, class_json)
                VALUES (%s, %s, %s, %s::jsonb)
                ON CONFLICT (h3_index) DO UPDATE SET
                    urban_class = EXCLUDED.urban_class,
                    class_count = EXCLUDED.class_count,
                    class_json  = EXCLUDED.class_json,
                    updated_at  = now()
                """,
                rows,
                page_size=BATCH_SIZE,
            )
        conn.commit()
        log.info("Done — %d rows upserted into urbanisation.", len(rows))
    except Exception:
        conn.rollback()
        log.exception("Upsert failed, transaction rolled back.")
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
