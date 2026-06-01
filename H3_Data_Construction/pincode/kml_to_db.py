"""
kml_to_db.py
────────────
Extracts the KML from the India pincode KMZ file and loads every Placemark
into the `polygons` PostGIS table.

DB connection is driven by environment variables so it works both locally
and inside Docker:

    DB_HOST     (default: localhost)
    DB_PORT     (default: 5432)
    DB_NAME     (default: geointel_local)
    DB_USER     (default: postgres)
    DB_PASSWORD (default: password)

KMZ file resolution order:
  1. KMZ_PATH env var (absolute path)
  2. <script dir>/<first .kmz file found> ← same folder as this script
"""

import os
import glob
import zipfile
import logging
import tempfile

import pandas as pd
import geopandas as gpd
from lxml import etree
from shapely.geometry import Polygon, MultiPolygon
from sqlalchemy import create_engine

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# ── DB connection ─────────────────────────────────────────────────────────────
DB_HOST     = os.getenv("DB_HOST",     "localhost")
DB_PORT     = os.getenv("DB_PORT",     "5432")
DB_NAME     = os.getenv("DB_NAME",     "geointel_local")
DB_USER     = os.getenv("DB_USER",     "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "password")

DB_URL = f"postgresql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"


def find_kmz() -> str:
    """Return the path to the first .kmz file we can locate."""
    # 1. Explicit env override
    explicit = os.getenv("KMZ_PATH")
    if explicit:
        log.info("KMZ_PATH env var → %s", explicit)
        return explicit

    # 2. Same directory as this script.
    #    Locally: H3_Data_Construction/pincode/*.kmz
    #    In Docker: /app/pincode/*.kmz  (H3_Data_Construction is mounted as /app)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    local_hits = glob.glob(os.path.join(script_dir, "*.kmz"))
    if local_hits:
        log.info("Found KMZ next to script: %s", local_hits[0])
        return local_hits[0]

    raise FileNotFoundError(
        "No .kmz file found. Set KMZ_PATH env var or place the .kmz file "
        "in the same directory as this script."
    )


def extract_kml(kmz_path: str, tmp_dir: str) -> str:
    """Unzip the KMZ and return the path to the first .kml file inside."""
    log.info("Extracting KMZ: %s", kmz_path)
    with zipfile.ZipFile(kmz_path, "r") as z:
        kml_names = [n for n in z.namelist() if n.lower().endswith(".kml")]
        if not kml_names:
            raise ValueError(f"No .kml file found inside {kmz_path}")
        z.extract(kml_names[0], tmp_dir)
        kml_path = os.path.join(tmp_dir, kml_names[0])
        log.info("Extracted KML → %s", kml_path)
        return kml_path


def parse_geometry(placemark, ns):
    """Parse single Polygons or MultiGeometry blocks into a MultiPolygon."""
    polygons = []
    for poly_node in placemark.xpath('.//kml:Polygon', namespaces=ns):
        coords_text = poly_node.xpath(
            './/kml:outerBoundaryIs//kml:coordinates/text()', namespaces=ns
        )
        if coords_text:
            raw_coords = coords_text[0].strip().split()
            points = []
            for c in raw_coords:
                parts = c.split(',')
                if len(parts) >= 2:
                    points.append((float(parts[0]), float(parts[1])))
            if len(points) >= 3:
                polygons.append(Polygon(points))
    if not polygons:
        return None
    return MultiPolygon(polygons)


def kml_to_postgres(kml_path: str, db_url: str):
    log.info("Parsing KML …")
    tree = etree.parse(kml_path)
    root = tree.getroot()
    ns = {'kml': 'http://www.opengis.net/kml/2.2'}

    data_list = []
    for pm in root.xpath('.//kml:Placemark', namespaces=ns):
        row = {}
        for sd in pm.xpath('.//kml:SimpleData', namespaces=ns):
            row[sd.get('name')] = sd.text
        geom = parse_geometry(pm, ns)
        if geom:
            row['geometry'] = geom
            data_list.append(row)

    if not data_list:
        log.error("No Placemark data found in KML — aborting.")
        return

    log.info("Parsed %d placemarks", len(data_list))
    gdf = gpd.GeoDataFrame(data_list, crs="EPSG:4326")
    gdf["type"] = "pincode"

    centroid = gdf.geometry.centroid
    gdf["lat"]  = centroid.y.round(6)
    gdf["long"] = centroid.x.round(6)

    log.info("Writing to PostgreSQL table 'polygons' …")
    engine = create_engine(db_url)
    gdf.to_postgis("polygons", engine, if_exists='replace', index=False)
    log.info("✅ Saved %d rows to 'polygons'.", len(gdf))


def main():
    kmz_path = find_kmz()

    with tempfile.TemporaryDirectory() as tmp_dir:
        kml_path = extract_kml(kmz_path, tmp_dir)
        kml_to_postgres(kml_path, DB_URL)


if __name__ == "__main__":
    main()
