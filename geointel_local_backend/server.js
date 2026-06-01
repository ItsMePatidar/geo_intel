// server.js - Minimal API for fetching H3 cell counts

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const app = express();
const PORT = 5000;

// Middleware
app.use(cors());
// app.use(express.json());
app.use(express.json({ limit: '10000mb' }));
// PostgreSQL connection setup
const pool = new Pool({
  user:     process.env.DB_USER     || 'postgres',
  host:     process.env.DB_HOST     || 'localhost',
  database: process.env.DB_NAME     || 'geointel_local',
  password: process.env.DB_PASSWORD || 'password',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
});

// GET /api/h3cells - Fetch hex and count from h3cells table
app.get('/api/h3cells', async (req, res) => {
  try {
    const result = await pool.query('SELECT hex, count FROM h3cells');
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching h3cells:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch h3cells',
      error: error.message
    });
  }
});

// POST /api/h3cells/import — upsert rows from a CSV upload [{hex, count}, …]
app.post('/api/h3cells/import', async (req, res) => {
  const { rows } = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ success: false, message: '`rows` must be a non-empty array' });
  }

  const hexes  = rows.map(r => String(r.hex));
  const counts = rows.map(r => Number(r.count));

  if (hexes.some(h => !h) || counts.some(c => isNaN(c))) {
    return res.status(400).json({ success: false, message: 'Every row must have a valid hex and numeric count' });
  }

  try {
    // Parallel unnest: each hex gets its own count
    await pool.query(
      `INSERT INTO h3cells (hex, count)
       SELECT unnest($1::text[]), unnest($2::integer[])
       ON CONFLICT (hex) DO UPDATE SET count = EXCLUDED.count`,
      [hexes, counts]
    );

    res.json({ success: true, imported: rows.length, message: `Imported ${rows.length} row(s)` });
  } catch (error) {
    console.error('Error in /import:', error);
    res.status(500).json({ success: false, message: 'Import failed', error: error.message });
  }
});

// POST /api/h3cells/bulk-update — upsert count for every hex in the selection
app.post('/api/h3cells/bulk-update', async (req, res) => {
  const { hexes, count } = req.body;

  if (!Array.isArray(hexes) || hexes.length === 0) {
    return res.status(400).json({ success: false, message: 'hexes must be a non-empty array' });
  }
  if (typeof count !== 'number') {
    return res.status(400).json({ success: false, message: 'count must be a number' });
  }

  try {
    // INSERT … ON CONFLICT updates existing rows, inserts new ones
    const result = await pool.query(
      `INSERT INTO h3cells (hex, count)
       SELECT unnest($1::text[]), $2::integer
       ON CONFLICT (hex) DO UPDATE SET count = EXCLUDED.count`,
      [hexes, count]
    );

    res.json({
      success: true,
      updated: hexes.length,
      message: `Successfully updated ${hexes.length} cell(s)`
    });
  } catch (error) {
    console.error('Error in bulk-update:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update h3cells',
      error: error.message
    });
  }
});

// Whitelisted world-cover table names
const WC_VALID_TABLES = new Set([
  'world_cover',
  'world_population',
]);

// GET /api/world-cover-layer?table=world_cover_3
// Fetch hex + world_cover_index for any valid world_cover table
app.get('/api/world-cover-layer', async (req, res) => {
  const { table } = req.query;
  if (!table || !WC_VALID_TABLES.has(table)) {
    return res.status(400).json({ success: false, message: `Invalid table name. Must be one of: ${[...WC_VALID_TABLES].join(', ')}` });
  }
  try {
    const result = await pool.query(`SELECT hex, ${table}_index AS world_cover_index FROM ${table}`);
    res.json({ success: true, table, count: result.rows.length, data: result.rows });
  } catch (error) {
    console.error(`Error fetching ${table}:`, error);
    res.status(500).json({ success: false, message: `Failed to fetch ${table}`, error: error.message });
  }
});

// GET /api/pincode-search?pincode=411001
// Fetches the boundary polygon for a single pincode
app.get('/api/pincode-search', async (req, res) => {
  const { pincode } = req.query;

  if (!pincode || !pincode.trim()) {
    return res.status(400).json({ success: false, message: '`pincode` query parameter is required' });
  }

  try {
    const result = await pool.query(
      `SELECT "Pincode", "Circle", ST_AsGeoJSON("geometry")::json AS geom
       FROM polygons
       WHERE "Pincode"::text = $1`,
      [pincode.trim()]
    );

    const features = result.rows.map(row => ({
      type: 'Feature',
      geometry: row.geom,
      properties: { pincode: row.Pincode, circle: row.circle },
    }));

    res.json({
      success: true,
      count: features.length,
      data: { type: 'FeatureCollection', features },
    });
  } catch (error) {
    console.error('Error in /api/pincode-search:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch pincode', error: error.message });
  }
});

// GET /api/pincode-boundaries?circle=<name>
// Fetches all pincode polygons for the given circle from polygons table
app.get('/api/pincode-boundaries', async (req, res) => {
  const { circle } = req.query;

  if (!circle || !circle.trim()) {
    return res.status(400).json({ success: false, message: '`circle` query parameter is required' });
  }

  try {
    const result = await pool.query(
      `SELECT "Pincode", "Circle", ST_AsGeoJSON("geometry")::json AS geom
       FROM polygons
       WHERE TRIM(LOWER("Circle")) != LOWER($1)`,
      [circle.trim()]
    );

    const features = result.rows.map(row => ({
      type: 'Feature',
      geometry: row.geom,
      properties: {
        pincode: row.Pincode,
        circle:  row.circle,
      },
    }));

    res.json({
      success: true,
      count: features.length,
      data: { type: 'FeatureCollection', features },
    });
  } catch (error) {
    console.error('Error fetching pincode boundaries:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pincode boundaries',
      error: error.message,
    });
  }
});

// POST /api/query-layer — run a user-supplied SELECT and return rows
// Supports an optional `clip` object to spatially filter results to the active bound.
// Supports `{bound}` template in the SQL which is replaced with the bound geometry expression.
// NOTE: executes arbitrary SQL; intended for local / trusted-network use only.
app.post('/api/query-layer', async (req, res) => {
  const { query, clip } = req.body;
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ success: false, message: '`query` is required' });
  }

  try {
    // ── Build bound geometry expression (parameterized) ─────────────────
    let boundExpr = null;
    const params  = [];

    if (clip) {
      const { boundMeta, boundPolygon } = clip;
      if (boundMeta?.type === 'pincodes' && boundMeta.values?.length) {
        params.push(boundMeta.values.map(String));
        boundExpr = `(SELECT ST_Union(geometry) FROM polygons WHERE "Pincode"::text = ANY($${params.length}))`;
      } else if (boundMeta?.type === 'circles' && boundMeta.values?.length) {
        params.push(boundMeta.values.map(v => v.toLowerCase().trim()));
        boundExpr = `(SELECT ST_Union(geometry) FROM polygons WHERE LOWER(TRIM("Circle")) = ANY($${params.length}::text[]))`;
      } else if (boundPolygon) {
        params.push(JSON.stringify(boundPolygon));
        boundExpr = `ST_SetSRID(ST_GeomFromGeoJSON($${params.length}), 4326)`;
      }
    }

    // ── Handle {bound} template substitution ─────────────────────────────
    let finalQuery = query;
    if (query.includes('{bound}')) {
      if (!boundExpr) {
        return res.status(400).json({
          success: false,
          message: 'Query uses {bound} but no bound is currently selected. Draw a polygon or choose a pincode/circle first.',
        });
      }
      finalQuery = query.replace(/\{bound\}/g, boundExpr);
      const result = await pool.query(finalQuery, params);
      return res.json({ success: true, count: result.rows.length, data: result.rows });
    }

    // ── Auto-clip: wrap query and inject spatial filter ───────────────────
    if (boundExpr) {
      // Run LIMIT 0 to discover column names without fetching data
      const probe  = await pool.query(`SELECT * FROM (${query}) __probe LIMIT 0`);
      const cols   = probe.fields.map(f => f.name);

      const hasLatLng = cols.includes('lat') && (cols.includes('long') || cols.includes('lng'));
      const hasHex    = cols.includes('hex');
      const lngCol    = cols.includes('long') ? 'long' : 'lng';

      if (hasLatLng) {
        // Point / scatter layer — filter by lat/long centroid
        finalQuery = `
          WITH __q AS (${query})
          SELECT __q.* FROM __q
          WHERE ST_Within(
            ST_SetSRID(ST_MakePoint(__q."${lngCol}"::float8, __q.lat::float8), 4326),
            ${boundExpr}
          )`;
      } else if (hasHex) {
        // H3 hex layer — join h3_grids to get centroid lat/long
        finalQuery = `
          WITH __q AS (${query})
          SELECT __q.* FROM __q
          JOIN h3_grids __h ON __h.h3_index = __q.hex
          WHERE ST_Within(
            ST_SetSRID(ST_MakePoint(__h.long::float8, __h.lat::float8), 4326),
            ${boundExpr}
          )`;
      }
      // geo_json (polygon) layers: no simple centroid filter, skip auto-clip
    }

    const result = await pool.query(finalQuery, params);
    const rows   = result.rows;

    if (rows.length > 0) {
      const keys = Object.keys(rows[0]);
      const hasHex     = keys.includes('hex');
      const hasLatLng  = (keys.includes('lat') || keys.includes('latitude')) &&
                         (keys.includes('long') || keys.includes('lng') || keys.includes('longitude'));
      const hasGeoJson = keys.includes('geo_json');
      if (!hasHex && !hasLatLng && !hasGeoJson) {
        return res.status(400).json({
          success: false,
          message: 'Query must return "hex" (hex layer), "lat"/"long" (point/scatter), or "geo_json" (polygon layer)',
        });
      }
    }
    res.json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    console.log(finalQuery)
    console.error('Error in /api/query-layer:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/world-population-layer
// Fetches hex + world_population_index from world_population table
app.get('/api/world-population-layer', async (req, res) => {
  try {
    const result = await pool.query('SELECT hex, world_population_index FROM world_population');
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) {
    console.error('Error fetching world_population:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch world population layer',
      error: error.message,
    });
  }
});

// POST /api/h3-grids
// Accepts a GeoJSON polygon and returns every row from h3_grids whose
// (long, lat) centre falls within that polygon.
// Body: { polygon: <GeoJSON Polygon or MultiPolygon> }
app.post('/api/h3-grids', async (req, res) => {
  const { polygon } = req.body;
  if (!polygon || !polygon.type) {
    return res.status(400).json({ success: false, message: '`polygon` GeoJSON is required' });
  }
  try {
    const result = await pool.query(
      `SELECT
          h3_index,
          resolution,
          lat::float            AS lat,
          long::float           AS long,
          pincode,
          city,
          state,
          population,
          dominant_class,
          class_count,
          class_json,
          base_updated_at,
          population_updated_at,
          land_cover_updated_at
       FROM h3_grids
       WHERE ST_Within(
         ST_SetSRID(ST_MakePoint("long"::float8, "lat"::float8), 4326),
         ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)
       )`,
      [JSON.stringify(polygon)]
    );
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) {
    console.error('Error in /api/h3-grids:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Server-side bound helpers (circle / pincode) ──────────────────────────
// These avoid sending large unioned geometries over the network by doing the
// spatial join in a single SQL query against the `polygons` table.

// POST /api/h3-grids-by-bound
// Body: { boundType: 'pincodes'|'circles', values: [...] }
app.post('/api/h3-grids-by-bound', async (req, res) => {
  const { boundType, values } = req.body;
  if (!boundType || !Array.isArray(values) || !values.length)
    return res.status(400).json({ success: false, message: '`boundType` and `values` required' });

  const whereClause = boundType === 'pincodes'
    ? `"Pincode"::text = ANY($1)`
    : `LOWER(TRIM("Circle")) = ANY($1::text[])`;
  const params = boundType === 'pincodes'
    ? [values.map(String)]
    : [values.map(v => v.toLowerCase().trim())];

  try {
    const result = await pool.query(
      `SELECT h3_index, resolution, lat::float, long::float,
              pincode, city, state, population,
              dominant_class, class_count, class_json,
              base_updated_at, population_updated_at, land_cover_updated_at
       FROM h3_grids h
       WHERE ST_Within(
         ST_SetSRID(ST_MakePoint(h.long::float8, h.lat::float8), 4326),
         (SELECT ST_Union(geometry) FROM polygons WHERE ${whereClause})
       )`, params
    );
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) {
    console.error('Error in /api/h3-grids-by-bound:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/points-by-bound
app.post('/api/points-by-bound', async (req, res) => {
  const { boundType, values } = req.body;
  if (!boundType || !Array.isArray(values) || !values.length)
    return res.status(400).json({ success: false, message: '`boundType` and `values` required' });

  const whereClause = boundType === 'pincodes'
    ? `"Pincode"::text = ANY($1)`
    : `LOWER(TRIM("Circle")) = ANY($1::text[])`;
  const params = boundType === 'pincodes'
    ? [values.map(String)]
    : [values.map(v => v.toLowerCase().trim())];

  try {
    const result = await pool.query(
      `SELECT id, lat::float, long::float, category, name
       FROM points p
       WHERE ST_Within(
         ST_SetSRID(ST_MakePoint(p.long::float8, p.lat::float8), 4326),
         (SELECT ST_Union(geometry) FROM polygons WHERE ${whereClause})
       )`, params
    );
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) {
    console.error('Error in /api/points-by-bound:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/polygons-by-bound
app.post('/api/polygons-by-bound', async (req, res) => {
  const { boundType, values } = req.body;
  if (!boundType || !Array.isArray(values) || !values.length)
    return res.status(400).json({ success: false, message: '`boundType` and `values` required' });

  const whereClause = boundType === 'pincodes'
    ? `"Pincode"::text = ANY($1)`
    : `LOWER(TRIM("Circle")) = ANY($1::text[])`;
  const params = boundType === 'pincodes'
    ? [values.map(String)]
    : [values.map(v => v.toLowerCase().trim())];

  try {
    const result = await pool.query(
      `SELECT "Pincode", "Circle", type, lat::float, long::float,
              ST_AsGeoJSON(geometry)::json AS geo_json
       FROM polygons p
       WHERE lat IS NOT NULL AND long IS NOT NULL
         AND ST_Within(
           ST_SetSRID(ST_MakePoint(p.long::float8, p.lat::float8), 4326),
           (SELECT ST_Union(geometry) FROM polygons b WHERE ${whereClause})
         )`, params
    );
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) {
    console.error('Error in /api/polygons-by-bound:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/points-by-polygon
// Returns all points whose lat/long falls within the given GeoJSON polygon.
app.post('/api/points-by-polygon', async (req, res) => {
  const { polygon } = req.body;
  if (!polygon || !polygon.type) {
    return res.status(400).json({ success: false, message: '`polygon` GeoJSON is required' });
  }
  try {
    const result = await pool.query(
      `SELECT id, lat::float, long::float, category, name
       FROM points
       WHERE ST_Within(
         ST_SetSRID(ST_MakePoint("long"::float8, "lat"::float8), 4326),
         ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)
       )`,
      [JSON.stringify(polygon)]
    );
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) {
    console.error('Error in /api/points-by-polygon:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/polygons-by-polygon
// Returns all polygons whose centroid (lat/long) falls within the given GeoJSON polygon.
app.post('/api/polygons-by-polygon', async (req, res) => {
  const { polygon } = req.body;
  if (!polygon || !polygon.type) {
    return res.status(400).json({ success: false, message: '`polygon` GeoJSON is required' });
  }
  try {
    const result = await pool.query(
      `SELECT "Pincode", "Circle", type, lat::float, long::float,
              ST_AsGeoJSON(geometry)::json AS geo_json
       FROM polygons
       WHERE lat IS NOT NULL AND long IS NOT NULL
         AND ST_Within(
           ST_SetSRID(ST_MakePoint("long"::float8, "lat"::float8), 4326),
           ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)
         )`,
      [JSON.stringify(polygon)]
    );
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) {
    console.error('Error in /api/polygons-by-polygon:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/bound-geometry
// Returns the ST_Union geometry for a set of pincodes or circles.
// Body: { type: 'pincodes', values: ['411001','411002'] }
//    or { type: 'circles',  values: ['Pune'] }
app.post('/api/bound-geometry', async (req, res) => {
  const { type, values } = req.body;
  if (!type || !Array.isArray(values) || values.length === 0) {
    return res.status(400).json({ success: false, message: '`type` and `values` array are required' });
  }
  try {
    let query, params;
    if (type === 'pincodes') {
      query = `SELECT ST_AsGeoJSON(ST_Union(geometry))::json AS geom FROM polygons WHERE "Pincode"::text = ANY($1)`;
      params = [values.map(String)];
    } else if (type === 'circles') {
      query = `SELECT ST_AsGeoJSON(ST_Union(geometry))::json AS geom FROM polygons WHERE LOWER(TRIM("Circle")) = ANY($1::text[])`;
      params = [values.map(v => v.toLowerCase().trim())];
    } else {
      return res.status(400).json({ success: false, message: '`type` must be "pincodes" or "circles"' });
    }
    const result = await pool.query(query, params);
    const geom = result.rows[0]?.geom;
    if (!geom) {
      return res.status(404).json({ success: false, message: `No polygons found for the given ${type}` });
    }
    res.json({ success: true, geometry: geom });
  } catch (error) {
    console.error('Error in /api/bound-geometry:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/bound-geometry-sql
// Accepts a user SQL query that returns rows with a `geometry` column (PostGIS),
// unions all returned geometries, and returns the result as a GeoJSON object.
// Body: { query: "SELECT geometry FROM polygons WHERE ..." }
app.post('/api/bound-geometry-sql', async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ success: false, message: '`query` is required' });
  }
  // Basic safety: only allow SELECT statements
  const trimmed = query.trim().toUpperCase();
  if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH')) {
    return res.status(400).json({ success: false, message: 'Only SELECT / WITH queries are permitted' });
  }
  try {
    // Wrap user query: union all geometries it returns.
    // Supports a `geometry` column (raw PostGIS) or a `geo_json` column (already-cast JSON).
    const wrapped = `
      SELECT ST_AsGeoJSON(
        ST_Union(
          CASE
            WHEN geometry IS NOT NULL THEN geometry
            ELSE NULL
          END
        )
      )::json AS geom
      FROM (${query.trim().replace(/;+$/, '')}) __sql_bound
    `;
    const result = await pool.query(wrapped);
    const geom = result.rows[0]?.geom;
    if (!geom) {
      return res.status(404).json({ success: false, message: 'Query returned no geometry rows' });
    }
    res.json({ success: true, geometry: geom });
  } catch (error) {
    console.error('Error in /api/bound-geometry-sql:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── No-filter endpoints (load entire tables) ─────────────────────────────

// GET /api/h3-grids-all — all rows from h3_grids, no spatial filter
app.get('/api/h3-grids-all', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT h3_index, resolution, lat::float, long::float,
              pincode, city, state, circle,
              population, dominant_class, class_count
       FROM h3_grids`
    );
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) {
    console.error('Error in /api/h3-grids-all:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/points-all — all rows from points, no spatial filter
app.get('/api/points-all', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM points');
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) {
    console.error('Error in /api/points-all:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/polygons-all — all rows from polygons with geometry as GeoJSON, no spatial filter
app.get('/api/polygons-all', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *, ST_AsGeoJSON(geometry)::json AS geo_json
       FROM polygons
       WHERE lat IS NOT NULL AND long IS NOT NULL`
    );
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) {
    console.error('Error in /api/polygons-all:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║   H3 Cells API Server Running             ║
║   Port: ${PORT}                              ║
║   http://localhost:${PORT}                   ║
╚════════════════════════════════════════════╝

Available Endpoints:
  GET    /api/h3cells
  POST   /api/h3cells/import
  POST   /api/h3cells/bulk-update
  GET    /api/pincode-boundaries
  `);
});