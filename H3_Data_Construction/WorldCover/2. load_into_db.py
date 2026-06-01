import rasterio
from rasterio.mask import mask
from rasterio.warp import transform_bounds
import h3
import geopandas as gpd
import numpy as np
from shapely.geometry import shape, mapping, Polygon, box
import pandas as pd
import json
import folium
from folium import GeoJson
import os
from psycopg2.extras import execute_batch
import psycopg2

# --- Config ---
TIFF_PATH = "/Users/priyanshpatidar/Documents/FPL/H3_Data_Construction/WorldCover/Data/ESA_WorldCover_10m_2020_v100_N18E072/ESA_WorldCover_10m_2020_v100_N18E072_Map.tif"
H3_RESOLUTION = 9  # ~174m hexagons; use 8 for ~461m

with open('/Users/priyanshpatidar/Documents/FPL/H3_Data_Construction/polygon.json', 'r') as file:
    data = json.load(file)

# Pune bounding box (rough)
PUNE_GEOJSON = {
    "type": "Polygon",
    "coordinates": [data['coordinates'][0]]
}

PUNE_LATLNG = [tuple(i) for i in data['coordinates'][0]]

# WorldCover class labels
WC_CLASSES = {
    10: "Tree cover", 20: "Shrubland", 30: "Grassland",
    40: "Cropland", 50: "Built-up", 60: "Bare/sparse veg",
    70: "Snow/ice", 80: "Water", 90: "Herbaceous wetland",
    95: "Mangroves", 100: "Moss/lichen"
}

# --- Step 0: Validate TIFF file exists and check CRS ---
if not os.path.exists(TIFF_PATH):
    raise FileNotFoundError(f"TIFF file not found: {TIFF_PATH}")

print("Opening raster file...")
with rasterio.open(TIFF_PATH) as src:
    print(f"  CRS: {src.crs}")
    print(f"  Bounds (in raster CRS): {src.bounds}")
    print(f"  Shape: {src.shape}")
    raster_crs = src.crs
    raster_bounds = src.bounds

# Transform raster bounds to EPSG:4326 if needed
if raster_crs and raster_crs != "EPSG:4326":
    print(f"  Converting bounds from {raster_crs} to EPSG:4326...")
    minx, miny, maxx, maxy = transform_bounds(raster_crs, "EPSG:4326", 
                                               raster_bounds.left, raster_bounds.bottom, 
                                               raster_bounds.right, raster_bounds.top)
    raster_bounds_4326 = (minx, miny, maxx, maxy)
    print(f"  Bounds in EPSG:4326: {raster_bounds_4326}")
else:
    raster_bounds_4326 = raster_bounds

# Check if Pune bbox overlaps with raster bounds
# pune_box = box(73.7, 18.4, 74.1, 18.7)
# raster_box = box(raster_bounds_4326[0], raster_bounds_4326[1], 
#                  raster_bounds_4326[2], raster_bounds_4326[3])

# if not pune_box.intersects(raster_box):
#     print("\n⚠️  WARNING: Pune bbox does NOT overlap with raster bounds!")
#     print(f"  Pune bbox: {pune_box.bounds}")
#     print(f"  Raster bounds: {raster_box.bounds}")
#     print("  → Expanding Pune bbox to match raster extent...")
#     PUNE_GEOJSON = mapping(raster_box)
# else:
#     print("✓ Pune bbox overlaps with raster")

# --- Step 1: Clip raster to Pune ---
print("\nClipping raster to region...")
try:
    with rasterio.open(TIFF_PATH) as src:
        out_image, out_transform = mask(src, [PUNE_GEOJSON], crop=True)
        out_meta = src.meta.copy()
        out_meta.update({
            "height": out_image.shape[1], 
            "width": out_image.shape[2], 
            "transform": out_transform
        })
        data = out_image[0]  # Single band
        bounds = src.bounds
        print(f"✓ Clipped data shape: {data.shape}")
except Exception as e:
    print(f"❌ Error during clipping: {e}")
    print("  Trying alternative approach...")
    with rasterio.open(TIFF_PATH) as src:
        data = src.read(1)
        out_meta = src.meta
        out_transform = src.transform
        bounds = src.bounds

# --- Step 2: Generate H3 cells covering Pune ---
print(f"\nGenerating H3 cells at resolution {H3_RESOLUTION}...")
h3_cells = list(h3.polygon_to_cells(h3.LatLngPoly(PUNE_LATLNG), H3_RESOLUTION))
print(f"✓ Total H3 cells: {len(h3_cells)}")

# --- Step 3: For each H3 cell, sample dominant land cover ---
print("\nSampling dominant land cover for each H3 cell...")
rows = []
failed_cells = 0

for idx, cell in enumerate(h3_cells):
    if idx % 1000 == 0:
        print(f"  Processing cell {idx}/{len(h3_cells)}...")
    
    # Get cell boundary as polygon
    boundary = h3.cell_to_boundary(cell)
    poly_coords = [[lng, lat] for lat, lng in boundary]
    poly = {"type": "Polygon", "coordinates": [poly_coords]}

    # try:
        # Sample raster within this hex
    with rasterio.open(TIFF_PATH) as src:
        clipped, _ = mask(src, [poly], crop=True, nodata=0)
        values = clipped[0].flatten()
        values = values[values > 0]  # Remove nodata and zeros
        
        if len(values) == 0:
            failed_cells += 1
            continue
        
        dominant_class = int(np.bincount(values.astype(int)).argmax())
        class_counts = {
            int(k): int(v) 
            for k, v in zip(*np.unique(values.astype(int), return_counts=True))
        }
        
        lat, lng = h3.cell_to_latlng(cell)
        rows.append({
            "h3_index": cell,
            "lat": lat,
            "lng": lng,
            "dominant_class": dominant_class,
            # "dominant_label": WC_CLASSES.get(dominant_class, "Unknown"),
            "class_counts": class_counts
        })
df = pd.DataFrame(rows)
DB_URL = 'postgresql://postgres:password@localhost:5432/geointel_local'




print("\nWriting results to world_cover table...")
 
world_cover_rows = [
    (row["h3_index"], row["dominant_class"])
    for _, row in df.iterrows()
]
 
try:
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()
 
    # Fetch existing hexes from h3cells and filter out missing ones
    cur.execute("SELECT hex FROM h3cells")
    existing_hexes = {row[0] for row in cur.fetchall()}
 
    filtered_rows = [(hex, wc) for hex, wc in world_cover_rows if hex in existing_hexes]
    skipped = len(world_cover_rows) - len(filtered_rows)
    if skipped:
        print(f"  ⚠️  Skipping {skipped} rows — hex not found in h3cells")
 
    execute_batch(
        cur,
        """
        INSERT INTO world_cover (hex, world_cover_index)
        VALUES (%s, %s)
        ON CONFLICT (hex) DO UPDATE
            SET world_cover_index = EXCLUDED.world_cover_index
        """,
        filtered_rows,
        page_size=500
    )
    print(f"  ✓ Upserted {len(filtered_rows)} rows into world_cover")
 
    conn.commit()
    print("✓ Database write complete")
 
except Exception as e:
    conn.rollback()
    print(f"❌ Database error: {e}")
    raise
 
finally:
    cur.close()
    conn.close()