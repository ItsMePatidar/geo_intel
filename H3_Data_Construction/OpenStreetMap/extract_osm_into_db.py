"""
extract_osm_into_db.py
──────────────────────
Streams through an OpenStreetMap .osm.pbf file and extracts Points of
Interest (nodes with a recognisable name + category tag) into the `points`
table.

Strategy
--------
* Uses pyosmium's SimpleHandler which reads the file as a C++ stream — safe
  for large files (the India PBF is ~1.6 GB) without loading everything into
  RAM.
* A bounding-box filter derived from polygon.json limits extraction to the
  region of interest (skips the bulk of India).
* OSM tags (amenity, shop, leisure, tourism, …) are mapped to the same
  category vocabulary used by load_points_into_db.py so all POIs look
  consistent in the front-end.
* INSERT … ON CONFLICT DO NOTHING so the script is safe to re-run.

DB connection is driven by environment variables (same as every other loader):

    DB_HOST     (default: localhost)
    DB_PORT     (default: 5432)
    DB_NAME     (default: geointel_local)
    DB_USER     (default: postgres)
    DB_PASSWORD (default: password)

File location is resolved in this order:
    1. OSM_PBF_PATH env var (absolute path)
    2. <script dir>/<first .osm.pbf file found>   ← same folder as this script

Run order in the full pipeline:
    …
    7. OpenStreetMap/extract_osm_into_db.py   ← this file
"""

import os
import glob
import json
import logging
from pathlib import Path

import osmium
import psycopg2
from psycopg2.extras import execute_batch

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
DB_CONFIG = {
    "host":     os.getenv("DB_HOST",     "localhost"),
    "port":     int(os.getenv("DB_PORT", 5432)),
    "dbname":   os.getenv("DB_NAME",     "geointel_local"),
    "user":     os.getenv("DB_USER",     "postgres"),
    "password": os.getenv("DB_PASSWORD", "password"),
}

BATCH_SIZE   = 500
POLYGON_PATH = Path(__file__).parent.parent / "polygon.json"


# ── OSM tag → category mapping ────────────────────────────────────────────────
# Maps OSM tag values to the same category strings used in load_points_into_db.py.
# Keys are tuples of (tag_key, tag_value); value is the category label.
# Order matters — first match wins.

AMENITY_MAP = {
    # Food & Dining
    "restaurant":    "Food & Dining",
    "cafe":          "Food & Dining",
    "fast_food":     "Food & Dining",
    "food_court":    "Food & Dining",
    "bar":           "Food & Dining",
    "pub":           "Food & Dining",
    "biergarten":    "Food & Dining",
    "ice_cream":     "Food & Dining",
    "juice_bar":     "Food & Dining",
    # Groceries
    "marketplace":   "Groceries",
    # Fuel
    "fuel":          "Fuel",
    # Health & Wellness
    "pharmacy":      "Health & Wellness",
    "hospital":      "Health & Wellness",
    "clinic":        "Health & Wellness",
    "doctors":       "Health & Wellness",
    "dentist":       "Health & Wellness",
    "veterinary":    "Health & Wellness",
    "spa":           "Health & Wellness",
    # Entertainment
    "cinema":        "Entertainment",
    "theatre":       "Entertainment",
    "arts_centre":   "Entertainment",
    "nightclub":     "Entertainment",
    "casino":        "Entertainment",
    # Finance
    "bank":          "Finance",
    "atm":           "Finance",
    "bureau_de_change": "Finance",
    # Education
    "school":        "Education",
    "university":    "Education",
    "college":       "Education",
    "kindergarten":  "Education",
    "library":       "Education",
    # Religious
    "place_of_worship": "Religious",
    # Transport
    "bus_station":   "Transport",
    "taxi":          "Transport",
    "car_rental":    "Transport",
}

SHOP_MAP = {
    # Groceries
    "supermarket":   "Groceries",
    "convenience":   "Groceries",
    "grocery":       "Groceries",
    "bakery":        "Groceries",
    "butcher":       "Groceries",
    "greengrocer":   "Groceries",
    # Electronics
    "electronics":   "Electronics",
    "computer":      "Electronics",
    "mobile_phone":  "Electronics",
    "hifi":          "Electronics",
    # Shopping
    "clothes":       "Shopping",
    "shoes":         "Shopping",
    "fashion":       "Shopping",
    "jewelry":       "Shopping",
    "gift":          "Shopping",
    "toys":          "Shopping",
    "books":         "Shopping",
    "sports":        "Shopping",
    "optician":      "Shopping",
    "hairdresser":   "Shopping",
    "beauty":        "Shopping",
    "cosmetics":     "Shopping",
    "department_store": "Shopping",
    "mall":          "Shopping",
    # Fuel (petrol pump shops)
    "fuel":          "Fuel",
}

LEISURE_MAP = {
    "park":            "Leisure & Sports",
    "stadium":         "Leisure & Sports",
    "sports_centre":   "Leisure & Sports",
    "fitness_centre":  "Leisure & Sports",
    "swimming_pool":   "Leisure & Sports",
    "golf_course":     "Leisure & Sports",
    "bowling_alley":   "Leisure & Sports",
    "amusement_arcade":"Leisure & Sports",
    "garden":          "Leisure & Sports",
}

TOURISM_MAP = {
    "hotel":        "Accommodation",
    "hostel":       "Accommodation",
    "guest_house":  "Accommodation",
    "motel":        "Accommodation",
    "apartment":    "Accommodation",
    "attraction":   "Tourism",
    "museum":       "Tourism",
    "viewpoint":    "Tourism",
    "monument":     "Tourism",
    "artwork":      "Tourism",
    "zoo":          "Tourism",
    "theme_park":   "Tourism",
}

OFFICE_MAP = {
    "government":   "Government",
    "police":       "Government",
    "post_office":  "Government",
    "fire_station": "Government",
}


def map_to_category(tags: dict) -> str | None:
    """
    Return a category string for an OSM node's tags, or None if the node
    doesn't match any category (i.e. should be skipped).
    """
    amenity = tags.get("amenity", "")
    shop    = tags.get("shop",    "")
    leisure = tags.get("leisure", "")
    tourism = tags.get("tourism", "")
    office  = tags.get("office",  "")

    if amenity and amenity in AMENITY_MAP:
        return AMENITY_MAP[amenity]
    if shop and shop in SHOP_MAP:
        return SHOP_MAP[shop]
    if leisure and leisure in LEISURE_MAP:
        return LEISURE_MAP[leisure]
    if tourism and tourism in TOURISM_MAP:
        return TOURISM_MAP[tourism]
    if office and office in OFFICE_MAP:
        return OFFICE_MAP[office]
    return None


# ── Bounding box helper ───────────────────────────────────────────────────────

def load_bbox_from_polygon(path: Path) -> tuple[float, float, float, float]:
    """
    Parse polygon.json and return (min_lat, min_lon, max_lat, max_lon).
    polygon.json uses [lat, lng] coordinate order (see load_base_into_db.py).
    """
    with open(path) as f:
        geojson = json.load(f)

    coords = geojson["coordinates"][0]
    # Detect order: if first value > 90 it is [lng, lat]; otherwise [lat, lng]
    sample = coords[0]
    if abs(sample[0]) > 90:
        # [lng, lat] — GeoJSON standard
        lats = [c[1] for c in coords]
        lons = [c[0] for c in coords]
    else:
        # [lat, lng] — as authored in this project
        lats = [c[0] for c in coords]
        lons = [c[1] for c in coords]

    return (min(lats), min(lons), max(lats), max(lons))


# ── OSM handler ───────────────────────────────────────────────────────────────

class POIHandler(osmium.SimpleHandler):
    """
    Streams through the PBF file.
    Collects (lat, lon, category, name) tuples for nodes that:
      - have a recognised category tag
      - have a 'name' tag (skip unnamed features)
      - fall within the bounding box
    """

    def __init__(self, min_lat: float, min_lon: float,
                       max_lat: float, max_lon: float):
        super().__init__()
        self.min_lat = min_lat
        self.min_lon = min_lon
        self.max_lat = max_lat
        self.max_lon = max_lon
        self.rows: list[tuple] = []
        self._scanned = 0

    def node(self, n):
        self._scanned += 1
        if self._scanned % 5_000_000 == 0:
            log.info("  … scanned %d nodes, %d POIs collected so far",
                     self._scanned, len(self.rows))

        # Fast bounding-box reject before any tag work
        lat = n.location.lat
        lon = n.location.lon
        if not (self.min_lat <= lat <= self.max_lat and
                self.min_lon <= lon <= self.max_lon):
            return

        tags = dict(n.tags)
        name = tags.get("name") or tags.get("name:en") or tags.get("brand")
        if not name:
            return

        category = map_to_category(tags)
        if category is None:
            return

        self.rows.append((round(lat, 6), round(lon, 6), category, name[:255]))


# ── PBF file resolution ───────────────────────────────────────────────────────

def find_pbf() -> str:
    """Return the path to the .osm.pbf file."""
    explicit = os.getenv("OSM_PBF_PATH")
    if explicit:
        log.info("OSM_PBF_PATH env var → %s", explicit)
        return explicit

    script_dir = os.path.dirname(os.path.abspath(__file__))
    hits = glob.glob(os.path.join(script_dir, "*.osm.pbf"))
    if hits:
        log.info("Found PBF next to script: %s", hits[0])
        return hits[0]

    raise FileNotFoundError(
        "No .osm.pbf file found. Set OSM_PBF_PATH env var or place the .pbf "
        "file in the same directory as this script (OpenStreetMap/)."
    )


# ── DB upsert ─────────────────────────────────────────────────────────────────

INSERT_SQL = """
    INSERT INTO points (lat, long, category, name)
    VALUES (%s, %s, %s, %s)
    ON CONFLICT DO NOTHING
"""


def load_into_db(rows: list[tuple]) -> None:
    log.info("Connecting to database …")
    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            log.info("Inserting %d POI rows (ON CONFLICT DO NOTHING) …", len(rows))
            execute_batch(cur, INSERT_SQL, rows, page_size=BATCH_SIZE)
        conn.commit()

        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM points")
            total = cur.fetchone()[0]
        log.info("✅ points table now has %d rows total.", total)
    except Exception:
        conn.rollback()
        log.exception("Insert failed, transaction rolled back.")
        raise
    finally:
        conn.close()


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    pbf_path = find_pbf()

    log.info("Loading bounding box from %s …", POLYGON_PATH)
    min_lat, min_lon, max_lat, max_lon = load_bbox_from_polygon(POLYGON_PATH)
    log.info("Bounding box: lat [%.4f, %.4f]  lon [%.4f, %.4f]",
             min_lat, max_lat, min_lon, max_lon)

    log.info("Streaming PBF: %s", pbf_path)
    handler = POIHandler(min_lat, min_lon, max_lat, max_lon)
    handler.apply_file(pbf_path, locations=True)

    log.info("Extracted %d POIs from %d scanned nodes.",
             len(handler.rows), handler._scanned)

    if not handler.rows:
        log.warning("No POIs found — check bounding box or tag mappings.")
        return

    # Log category breakdown
    from collections import Counter
    cats = Counter(r[2] for r in handler.rows)
    log.info("Category breakdown:")
    for cat, count in sorted(cats.items(), key=lambda x: -x[1]):
        log.info("  %-30s %d", cat, count)

    load_into_db(handler.rows)


if __name__ == "__main__":
    main()
