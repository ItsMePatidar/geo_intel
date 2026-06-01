// In development the Vite dev-server proxies /api → localhost:5000 (see vite.config).
// In production (Docker) nginx proxies /api → backend:5000.
const API_BASE_URL = '/api';

// Example backend route for fetching cells:
// app.get('/api/h3cells', async (req, res) => {
//   const result = await pool.query('SELECT hex, count FROM h3cells');
//   res.json({ success: true, data: result.rows });
// });

// Example backend route for bulk update:
// app.post('/api/h3cells/bulk-update', async (req, res) => {
//   const { hexes, count } = req.body;
//   await pool.query(
//     `INSERT INTO h3cells (hex, count)
//      VALUES (unnest($1::text[]), $2)
//      ON CONFLICT (hex) DO UPDATE SET count = EXCLUDED.count`,
//     [hexes, count]
//   );
//   res.json({ success: true, updated: hexes.length });
// });

/**
 * Fetch hex + world_cover_index for a specific world_cover table.
 * @param {string} table – e.g. 'world_cover', 'world_cover_3'
 */
export async function fetchWorldCoverLayer(table) {
  const res = await fetch(`${API_BASE_URL}/world-cover-layer?table=${encodeURIComponent(table)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const result = await res.json();
  if (!result.success) throw new Error(result.message || 'Failed to fetch world cover layer');
  return result.data;   // [{ hex, world_cover_index }, …]
}

/** Fetch all H3 cells from the local DB. */
export async function fetchH3Cells() {
  const res = await fetch(`${API_BASE_URL}/h3cells`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const result = await res.json();
  return result.data;
}

/**
 * Import rows from a CSV upload — each hex gets its own count.
 * @param {{ hex: string, count: number }[]} rows
 */
export async function importH3Cells(rows) {
  const res = await fetch(`${API_BASE_URL}/h3cells/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Fetch the boundary polygon for a single pincode from the DB.
 * @param {string} pincode – 6-digit pincode string
 */
export async function fetchPincodeByCode(pincode) {
  const res = await fetch(`${API_BASE_URL}/pincode-search?pincode=${encodeURIComponent(pincode)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const result = await res.json();
  if (!result.success) throw new Error(result.message || 'Failed to fetch pincode');
  return result.data;   // GeoJSON FeatureCollection
}

/**
 * Fetch all pincode boundary polygons for a given circle name.
 * Returns a GeoJSON FeatureCollection.
 * @param {string} circle – Circle name to filter by (case-insensitive)
 */
export async function fetchPincodeBoundaries(circle) {
  const res = await fetch(`${API_BASE_URL}/pincode-boundaries?circle=${encodeURIComponent(circle)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const result = await res.json();
  if (!result.success) throw new Error(result.message || 'Failed to fetch pincode boundaries');
  return result.data;   // GeoJSON FeatureCollection
}

/**
 * Fetch all H3 cells from the world_population table.
 * Returns [{ hex, world_population_index }, …]
 */
export async function fetchWorldPopulationLayer() {
  const res = await fetch(`${API_BASE_URL}/world-population-layer`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const result = await res.json();
  if (!result.success) throw new Error(result.message || 'Failed to fetch world population layer');
  return result.data;   // [{ hex, world_population_index }, …]
}

/**
 * Execute an arbitrary SQL query and return the result rows.
 * The query must return at least a `hex` column.
 * Optional columns: `colour` (CSS hex string), `height` (integer).
 * @param {string} query – SQL SELECT statement
 * @param {object} [clip] – optional bound-clip config
 *   clip.boundMeta    – { type: 'pincodes'|'circles'|'polygon', values?: string[] }
 *   clip.boundPolygon – GeoJSON geometry (used when boundMeta.type === 'polygon')
 */
export async function fetchQueryLayer(query, clip) {
  const res = await fetch(`${API_BASE_URL}/query-layer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, ...(clip ? { clip } : {}) }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  const result = await res.json();
  if (!result.success) throw new Error(result.message || 'Query failed');
  return result.data;   // [{ hex, colour?, height? }, …]
}

/**
 * Fetch all h3_grids rows whose cell centre falls within the given polygon.
 * @param {object} polygon – GeoJSON Polygon or MultiPolygon geometry
 * @returns {Promise<Array>} array of h3_grids rows
 */
export async function fetchH3GridsByPolygon(polygon) {
  const res = await fetch(`${API_BASE_URL}/h3-grids`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ polygon }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  const result = await res.json();
  if (!result.success) throw new Error(result.message || 'Failed to fetch h3 grids');
  return result.data;
}

/**
 * Fetch H3 grids / points / polygons using a server-side spatial join against
 * stored polygon boundaries — avoids sending large geometry over the network.
 * @param {'pincodes'|'circles'} boundType
 * @param {string[]} values
 */
async function _fetchByBound(endpoint, boundType, values) {
  const res = await fetch(`${API_BASE_URL}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ boundType, values }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  const result = await res.json();
  if (!result.success) throw new Error(result.message || `Failed to fetch from ${endpoint}`);
  return result.data;
}

export const fetchH3GridsByBound    = (t, v) => _fetchByBound('h3-grids-by-bound',    t, v)
export const fetchPointsByBound     = (t, v) => _fetchByBound('points-by-bound',      t, v)
export const fetchPolygonsByBound   = (t, v) => _fetchByBound('polygons-by-bound',    t, v)

/**
 * Fetch all points whose lat/long falls within the given GeoJSON polygon.
 * @param {object} polygon – GeoJSON Polygon or MultiPolygon geometry
 */
export async function fetchPointsByPolygon(polygon) {
  const res = await fetch(`${API_BASE_URL}/points-by-polygon`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ polygon }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  const result = await res.json();
  if (!result.success) throw new Error(result.message || 'Failed to fetch points');
  return result.data;
}

/**
 * Fetch all polygons whose centroid falls within the given GeoJSON polygon.
 * @param {object} polygon – GeoJSON Polygon or MultiPolygon geometry
 */
export async function fetchPolygonsByPolygon(polygon) {
  const res = await fetch(`${API_BASE_URL}/polygons-by-polygon`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ polygon }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  const result = await res.json();
  if (!result.success) throw new Error(result.message || 'Failed to fetch polygons');
  return result.data;
}

/**
 * Fetch the unioned GeoJSON geometry for a set of pincodes or circles.
 * @param {'pincodes'|'circles'} type
 * @param {string[]} values – pincode strings or circle names
 */
export async function fetchBoundGeometry(type, values) {
  const res = await fetch(`${API_BASE_URL}/bound-geometry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, values }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  const result = await res.json();
  if (!result.success) throw new Error(result.message || 'Failed to fetch bound geometry');
  return result.geometry;   // GeoJSON geometry (Polygon or MultiPolygon)
}

/**
 * Execute a SQL query that returns a `geometry` column, union all geometries,
 * and return the result as a GeoJSON object (Polygon or MultiPolygon).
 * Used to define a custom SQL-driven bound area.
 * @param {string} query – SQL SELECT statement returning rows with a geometry column
 */
export async function fetchBoundGeometrySQL(query) {
  const res = await fetch(`${API_BASE_URL}/bound-geometry-sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  const result = await res.json();
  if (!result.success) throw new Error(result.message || 'Failed to fetch SQL bound geometry');
  return result.geometry;  // GeoJSON geometry object
}

/**
 * Bulk-upsert a count value for every hex in the selection.
 * @param {string[]} hexes  – Array of H3 index strings
 * @param {number}   count  – Count value to write
 */
/** Fetch ALL h3_grids rows with no spatial filter. */
export async function fetchAllH3Grids() {
  const res = await fetch(`${API_BASE_URL}/h3-grids-all`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const result = await res.json();
  if (!result.success) throw new Error(result.message || 'Failed to fetch all H3 grids');
  return result.data;
}

/** Fetch ALL points rows with no spatial filter. */
export async function fetchAllPoints() {
  const res = await fetch(`${API_BASE_URL}/points-all`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const result = await res.json();
  if (!result.success) throw new Error(result.message || 'Failed to fetch all points');
  return result.data;
}

/** Fetch ALL polygons rows (with geo_json) with no spatial filter. */
export async function fetchAllPolygons() {
  const res = await fetch(`${API_BASE_URL}/polygons-all`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const result = await res.json();
  if (!result.success) throw new Error(result.message || 'Failed to fetch all polygons');
  return result.data;
}

export async function updateH3Cells(hexes, count) {
  const res = await fetch(`${API_BASE_URL}/h3cells/bulk-update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hexes: Array.from(hexes), count }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
