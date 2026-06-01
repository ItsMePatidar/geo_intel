#!/usr/bin/env bash
# run_all.sh — run all data-loader scripts in the correct order.
# Each step must succeed before the next one starts (set -e).
set -e

log() { echo ""; echo "════════════════════════════════════════"; echo "  $1"; echo "════════════════════════════════════════"; }

log "Step 1 / 5 — Pincode boundaries (KMZ → pincode_boundaries table)"
python pincode/kml_to_db.py

log "Step 2 / 5 — Base H3 grid"
python PrimaryH3/load_base_into_db.py

log "Step 3 / 5 — Enrich base with pincode / circle / city / state"
python pincode/enrich_base_with_pincode.py

log "Step 4 / 6 — Land cover (WorldCover GeoTIFF)"
python WorldCover/load_land_cover_into_db.py

log "Step 5 / 6 — Population (WorldPop GeoTIFF)"
python "WorldPop Population/load_population_into_db.py"

log "Step 6 / 7 — Points of Interest (static)"
python Points/load_points_into_db.py

log "Step 7 / 7 — Points of Interest (OpenStreetMap)"
python OpenStreetMap/extract_osm_into_db.py

echo ""
echo "✓ All loaders completed successfully."
