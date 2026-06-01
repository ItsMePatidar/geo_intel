/**
 * H3HexagonLayer — area selection, vertex drag, DB update
 *
 * Drawing flow:
 *  1. "Draw Selection" → crosshair cursor, click map to place vertices
 *  2. Double-click or "Finish" → closes polygon, h3.polyfill() highlights cells
 *  3. After completion → drag any vertex circle to reshape; selection updates on drop
 *  4. "Update DB" → type a count, write all selected cells to local DB
 *  5. "Clear" → reset everything
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { fetchH3Cells, updateH3Cells, importH3Cells, fetchPincodeBoundaries, fetchPincodeByCode, fetchQueryLayer, fetchH3GridsByPolygon, fetchPointsByPolygon, fetchPolygonsByPolygon, fetchBoundGeometry, fetchBoundGeometrySQL, fetchH3GridsByBound, fetchPointsByBound, fetchPolygonsByBound, fetchAllH3Grids, fetchAllPoints, fetchAllPolygons } from './api'

const BASE_LAYERS = [
  { id: 'positron',    label: 'Light',    bg: '#f2ede8', roads: '#d4cfc9', url: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json' },
  { id: 'dark-matter', label: 'Dark',     bg: '#1b1f2e', roads: '#2c3248', url: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json' },
  { id: 'voyager',     label: 'Streets',  bg: '#e8e0d5', roads: '#c8a96e', url: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json' },
  { id: 'liberty',     label: 'Detailed', bg: '#dce8d0', roads: '#b8cfa4', url: 'https://tiles.openfreemap.org/styles/liberty' },
]
const EMPTY_FC   = { type: 'FeatureCollection', features: [] }
const EMPTY_FEAT = (geom, props = {}) => ({ type: 'Feature', geometry: geom, properties: props })

// ── Kept for legacy use inside map/deck logic only ──────────────────────
const btn        = { cursor:'pointer', borderRadius:6, padding:'8px 12px', fontSize:12, fontWeight:500, lineHeight:1.2, transition:'background 0.15s, opacity 0.15s', fontFamily:'inherit' }
const row        = { display:'flex', alignItems:'center', justifyContent:'space-between', paddingBottom:8, marginBottom:8 }
const lbl        = { flex:1, fontSize:13, color:'#e6edf3', lineHeight:'1.2em' }
const countInput = { width:60, height:32, borderRadius:6, border:'1px solid #30363d', padding:'0 8px', fontSize:14, textAlign:'right', outline:'none', background:'#0d1117', color:'#e6edf3' }

// ── H3HexagonLayer factories ──────────────────────────────────────────────
function makeBaseLayer(H3Hex, data, opts) {
  return new H3Hex({
    id: 'h3-base',
    data: data || [],
    pickable: true,
    extruded: opts.extruded, wireframe: opts.wireframe,
    filled: true, coverage: opts.coverage, elevationScale: opts.elevationScale,
    getHexagon:   d => d.hex,
    getFillColor: d => [255, (1 - d.count / 500) * 255, 0],
    getElevation: d => d.count,
  })
}

function makeSelectionLayer(H3Hex, cells, opts) {
  if (!cells.size) return null
  return new H3Hex({
    id: 'h3-selection',
    data: Array.from(cells).map(hex => ({ hex })),
    pickable: false,
    extruded: opts.extruded, wireframe: false,
    filled: true, coverage: opts.coverage,
    elevationScale: opts.elevationScale * 1.4,
    getHexagon:   d => d.hex,
    getFillColor: [56, 189, 248, 210],   // sky-blue
    getElevation: 300,
  })
}

// CSV layer — orange→red gradient, each cell gets its own count-based colour
function makeCsvLayer(H3Hex, data, opts) {
  if (!data?.length) return null
  const maxCount = Math.max(...data.map(d => d.count), 1)
  return new H3Hex({
    id: 'h3-csv',
    data,
    pickable: true,
    extruded: opts.extruded,
    wireframe: opts.wireframe,
    filled: true,
    coverage: opts.coverage,
    elevationScale: opts.elevationScale,
    getHexagon:   d => d.hex,
    getFillColor: d => {
      const t = d.count / maxCount            // 0 → 1
      return [255, Math.round(165 - t * 145), Math.round(30 + t * 10), 220]
      //           orange (255,165,30) → crimson (255,20,40)
    },
    getElevation: d => d.count,
    updateTriggers: { getFillColor: maxCount },
  })
}

// ── CSV parser (no external library needed) ───────────────────────────────
function parseCSV(text) {
  const lines = text.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row')

  const parseRow = line => line.split(',').map(c => c.trim().replace(/^"|"$/g, ''))
  const headers  = parseRow(lines[0]).map(h => h.toLowerCase())

  const hexIdx   = headers.indexOf('hex')
  const countIdx = headers.indexOf('count')
  if (hexIdx   < 0) throw new Error('CSV is missing a "hex" column')
  if (countIdx < 0) throw new Error('CSV is missing a "count" column')

  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const cols  = parseRow(line)
    const hex   = cols[hexIdx]
    const count = Number(cols[countIdx])
    if (hex && !isNaN(count)) rows.push({ hex, count })
  }

  if (rows.length === 0) throw new Error('No valid rows found in the CSV')
  return rows
}

// ── Search helpers ────────────────────────────────────────────────────────

/**
 * Auto-detect the type of a search query.
 * Returns { type: 'latlng'|'h3'|'pincode'|'unknown', ...fields }
 */
function detectSearchType(query) {
  const q = query.trim()
  if (!q) return null

  // Lat/Lng — two decimal numbers separated by comma or whitespace
  const m = q.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/)
  if (m) {
    const lat = parseFloat(m[1]), lng = parseFloat(m[2])
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)
      return { type: 'latlng', lat, lng }
  }

  // H3 index — validate at runtime using the loaded h3-js library
  if (window.h3?.h3IsValid?.(q)) return { type: 'h3', index: q }

  // Indian pincode — exactly 6 digits
  if (/^\d{6}$/.test(q)) return { type: 'pincode', pincode: q }

  return { type: 'unknown' }
}

/** Convert an H3 cell index → GeoJSON FeatureCollection with one polygon. */
function h3ToSearchGeoJSON(index) {
  const boundary = window.h3.h3ToGeoBoundary(index)  // [[lat,lng], …]
  const coords   = boundary.map(([lat, lng]) => [lng, lat])
  coords.push(coords[0])                              // close ring
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry:   { type: 'Polygon', coordinates: [coords] },
      properties: { h3index: index, resolution: window.h3.h3GetResolution(index) },
    }],
  }
}

/** Compute [[minLng,minLat],[maxLng,maxLat]] from any GeoJSON FeatureCollection. */
function getGeoJSONBounds(fc) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
  const processRing = ring => {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat
    }
  }
  for (const feat of fc.features) {
    const { type, coordinates } = feat.geometry
    if (type === 'Polygon')      coordinates.forEach(processRing)
    if (type === 'MultiPolygon') coordinates.flat().forEach(processRing)
  }
  return [[minLng, minLat], [maxLng, maxLat]]
}

// Zoom level per H3 resolution for a comfortable view
const H3_RES_ZOOM = { 4:7, 5:8, 6:9, 7:11, 8:12, 9:13, 10:14, 11:15, 12:16 }

// ── Preset queries ────────────────────────────────────────────────────────
const PRESET_QUERIES = [
  {
    label: 'World Cover — land type (flat)',
    name:  'World Cover',
    query:
`SELECT hex,
       CASE world_cover_index
         WHEN 10  THEN '#006400'
         WHEN 20  THEN '#FFBB22'
         WHEN 30  THEN '#FFFF4C'
         WHEN 40  THEN '#F096FF'
         WHEN 50  THEN '#FA0000'
         WHEN 60  THEN '#B4B4B4'
         WHEN 70  THEN '#F0F0F0'
         WHEN 80  THEN '#0064C8'
         WHEN 90  THEN '#0096A0'
         WHEN 95  THEN '#00CF75'
         WHEN 100 THEN '#FAE6A0'
         ELSE '#888888'
       END AS colour,
       0 AS height
FROM world_cover`,
  },
  {
    label: 'World Population — 3D bars',
    name:  'World Population',
    query:
`SELECT hex,
       '#E05C2A' AS colour,
       world_population_index AS height
FROM world_population`,
  },
  {
    label: 'Points — shops, fuel pumps etc.',
    name:  'Points',
    query:
`SELECT lat, long, category, name
FROM points`,
  },
]

// ── Generic layer helpers ─────────────────────────────────────────────────

/** Parse a CSS hex colour string → [r, g, b]. Falls back to mid-grey. */
function hexColorToRgb(hex) {
  if (!hex || typeof hex !== 'string') return [128, 128, 128]
  const h = hex.replace('#', '')
  if (h.length !== 6 && h.length !== 3) return [128, 128, 128]
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  return [parseInt(full.slice(0,2),16), parseInt(full.slice(2,4),16), parseInt(full.slice(4,6),16)]
}

/** Detect layer type from the first data row.
 *  - 'hex'     → has `hex` column
 *  - 'polygon' → has `geo_json` column
 *  - 'scatter' → has lat/long + radius
 *  - 'point'   → has lat/long (+ category/name — icon pins)
 */
function detectLayerType(data) {
  if (!data?.length) return 'hex'
  const s = data[0]
  if (s.geo_json !== undefined) return 'polygon'
  const hasLatLng = s.lat !== undefined && (s.long !== undefined || s.lng !== undefined)
  if (!hasLatLng) return 'hex'
  return s.radius !== undefined ? 'scatter' : 'point'
}

// ── H3 hex layer ─────────────────────────────────────────────────────────
function makeHexLayer(H3Hex, layer) {
  if (!layer.data?.length || !layer.visible) return null
  const alpha = Math.round(layer.opacity * 255)
  return new H3Hex({
    id:             `h3-custom-${layer.id}`,
    data:           layer.data,
    pickable:       true,
    extruded:       true,
    wireframe:      false,
    filled:         true,
    coverage:       layer.coverage,
    elevationScale: layer.elevationScale,
    getHexagon:   d => d.hex,
    getFillColor: d => [...hexColorToRgb(d.colour), alpha],
    getElevation: d => d.height ?? 0,
    updateTriggers: { getFillColor: [layer.opacity] },
  })
}

// ── Teardrop pin icons ────────────────────────────────────────────────────
const PIN_COLORS = {
  'Food & Dining':     '#E53935',
  'Shopping':          '#3949AB',
  'Fuel':              '#F57C00',
  'Health & Wellness': '#00897B',
  'Groceries':         '#388E3C',
  'Electronics':       '#6A1B9A',
  'Entertainment':     '#C2185B',
  // OSM-extracted categories
  'Finance':           '#1565C0',
  'Education':         '#0277BD',
  'Religious':         '#6D4C41',
  'Transport':         '#00838F',
  'Leisure & Sports':  '#2E7D32',
  'Accommodation':     '#AD1457',
  'Tourism':           '#F57F17',
  'Government':        '#4527A0',
  default:             '#607D8B',
}

// SVG fragments for each category — "COLOR" is replaced at build time
const PIN_ICON_PATHS = {
  'Food & Dining':
    `<line x1="18" y1="14" x2="18" y2="32" stroke="COLOR" stroke-width="2" stroke-linecap="round"/>` +
    `<line x1="18" y1="14" x2="18" y2="20" stroke="COLOR" stroke-width="1.5"/>` +
    `<line x1="21" y1="14" x2="21" y2="20" stroke="COLOR" stroke-width="1.5"/>` +
    `<path d="M18 20Q19.5 22 21 20" fill="none" stroke="COLOR" stroke-width="1.5"/>` +
    `<line x1="27" y1="14" x2="27" y2="32" stroke="COLOR" stroke-width="2" stroke-linecap="round"/>` +
    `<path d="M27 14Q31 17 27 21" fill="COLOR"/>`,

  'Shopping':
    `<rect x="16" y="19" width="16" height="13" rx="2" fill="none" stroke="COLOR" stroke-width="2"/>` +
    `<path d="M20 19Q20 14 24 14Q28 14 28 19" fill="none" stroke="COLOR" stroke-width="2" stroke-linecap="round"/>` +
    `<circle cx="24" cy="25" r="1.5" fill="COLOR"/>`,

  'Fuel':
    `<rect x="16" y="15" width="9" height="16" rx="1.5" fill="none" stroke="COLOR" stroke-width="2"/>` +
    `<line x1="25" y1="18" x2="30" y2="18" stroke="COLOR" stroke-width="2" stroke-linecap="round"/>` +
    `<line x1="30" y1="18" x2="30" y2="22" stroke="COLOR" stroke-width="2" stroke-linecap="round"/>` +
    `<line x1="30" y1="22" x2="28" y2="24" stroke="COLOR" stroke-width="2.5" stroke-linecap="round"/>` +
    `<rect x="18" y="17" width="5" height="4" rx="0.5" fill="COLOR" opacity="0.4"/>`,

  'Health & Wellness':
    `<rect x="21.5" y="15" width="5" height="16" rx="2" fill="COLOR"/>` +
    `<rect x="16" y="20.5" width="16" height="5" rx="2" fill="COLOR"/>`,

  'Groceries':
    `<path d="M14 15L16 15L19 27L30 27L32 19L17 19" fill="none" stroke="COLOR" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="20" cy="30" r="1.8" fill="COLOR"/>` +
    `<circle cx="28.5" cy="30" r="1.8" fill="COLOR"/>`,

  'Electronics':
    `<path d="M27 13L20 24L25 24L21 33L29 20L24 20Z" fill="COLOR"/>`,

  'Entertainment':
    `<polygon points="19,16 19,30 32,23" fill="COLOR"/>`,

  // ── OSM-extracted categories ────────────────────────────────────────────

  // Finance — bank building (3 columns + pediment + base steps)
  'Finance':
    `<rect x="15" y="28" width="18" height="3" rx="0.5" fill="COLOR"/>` +
    `<rect x="13" y="31" width="22" height="2" rx="0.5" fill="COLOR" opacity="0.7"/>` +
    `<rect x="17" y="16" width="2.5" height="12" fill="COLOR"/>` +
    `<rect x="22.75" y="16" width="2.5" height="12" fill="COLOR"/>` +
    `<rect x="28.5" y="16" width="2.5" height="12" fill="COLOR"/>` +
    `<path d="M14 16L24 11L34 16Z" fill="COLOR"/>`,

  // Education — graduation mortarboard cap
  'Education':
    `<path d="M24 13L34 18L24 23L14 18Z" fill="COLOR"/>` +
    `<path d="M19.5 20.5L19.5 28Q24 30.5 28.5 28L28.5 20.5" fill="COLOR" opacity="0.75"/>` +
    `<line x1="34" y1="18" x2="34" y2="25" stroke="COLOR" stroke-width="2" stroke-linecap="round"/>` +
    `<circle cx="34" cy="26.5" r="1.8" fill="COLOR"/>`,

  // Religious — 8-pointed star (universal place-of-worship symbol)
  'Religious':
    `<path d="M24 12L25.8 18.6L32 15.5L28.9 21.5L35.5 23.3L28.9 25.1L32 31.1L25.8 28L24 34.6L22.2 28L16 31.1L19.1 25.1L12.5 23.3L19.1 21.5L16 15.5L22.2 18.6Z" fill="COLOR" opacity="0.9"/>`,

  // Transport — front view of a bus
  'Transport':
    `<rect x="15" y="15" width="18" height="14" rx="2.5" fill="none" stroke="COLOR" stroke-width="2"/>` +
    `<rect x="17" y="17" width="5.5" height="5" rx="1" fill="COLOR" opacity="0.5"/>` +
    `<rect x="25.5" y="17" width="5.5" height="5" rx="1" fill="COLOR" opacity="0.5"/>` +
    `<line x1="15" y1="23" x2="33" y2="23" stroke="COLOR" stroke-width="1.5"/>` +
    `<circle cx="19.5" cy="31" r="2.2" fill="COLOR"/>` +
    `<circle cx="28.5" cy="31" r="2.2" fill="COLOR"/>`,

  // Leisure & Sports — dumbbell / weights
  'Leisure & Sports':
    `<rect x="18" y="21" width="12" height="4" rx="2" fill="COLOR"/>` +
    `<rect x="12" y="17.5" width="6" height="11" rx="2.5" fill="COLOR"/>` +
    `<rect x="30" y="17.5" width="6" height="11" rx="2.5" fill="COLOR"/>`,

  // Accommodation — hotel bed with headboard + legs
  'Accommodation':
    `<rect x="14" y="21" width="20" height="10" rx="2" fill="none" stroke="COLOR" stroke-width="2"/>` +
    `<rect x="14" y="15" width="4" height="10" rx="2" fill="COLOR"/>` +
    `<line x1="14" y1="23" x2="34" y2="23" stroke="COLOR" stroke-width="1.5"/>` +
    `<rect x="17" y="24" width="8" height="5" rx="1.5" fill="COLOR" opacity="0.55"/>` +
    `<rect x="14" y="31" width="2.5" height="4" rx="1" fill="COLOR"/>` +
    `<rect x="31.5" y="31" width="2.5" height="4" rx="1" fill="COLOR"/>`,

  // Tourism — camera body + lens + viewfinder bump
  'Tourism':
    `<rect x="13" y="19" width="22" height="14" rx="2.5" fill="none" stroke="COLOR" stroke-width="2"/>` +
    `<circle cx="24" cy="26" r="4.5" fill="none" stroke="COLOR" stroke-width="2"/>` +
    `<circle cx="24" cy="26" r="2" fill="COLOR"/>` +
    `<rect x="20" y="14.5" width="7" height="5" rx="1.5" fill="COLOR"/>` +
    `<circle cx="30.5" cy="22" r="1.5" fill="COLOR"/>`,

  // Government — civic building with flag on top
  'Government':
    `<rect x="17" y="20" width="14" height="11" fill="none" stroke="COLOR" stroke-width="2"/>` +
    `<rect x="21" y="23" width="3" height="8" fill="COLOR"/>` +
    `<rect x="26" y="23" width="3" height="8" fill="COLOR"/>` +
    `<rect x="13" y="31" width="22" height="2.5" rx="0.5" fill="COLOR"/>` +
    `<line x1="24" y1="12" x2="24" y2="20" stroke="COLOR" stroke-width="1.8" stroke-linecap="round"/>` +
    `<path d="M24 12L30 14.5L24 17Z" fill="COLOR"/>`,

  default:
    `<circle cx="24" cy="23" r="5" fill="COLOR"/>`,
}

/** Build a data URL for a teardrop pin SVG for the given category. */
function makePinDataUrl(category) {
  const color = PIN_COLORS[category] ?? PIN_COLORS.default
  const icon  = (PIN_ICON_PATHS[category] ?? PIN_ICON_PATHS.default).replace(/COLOR/g, color)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 60" width="48" height="60">` +
    `<path d="M24,0C10.7,0,0,10.7,0,24C0,37.3,24,60,24,60C24,60,48,37.3,48,24C48,10.7,37.3,0,24,0Z" fill="${color}"/>` +
    `<circle cx="24" cy="23" r="14" fill="white" opacity="0.95"/>` +
    icon +
    `</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

// Pre-compute all pin URLs once at module load
const CATEGORY_PIN_URLS = Object.fromEntries(
  Object.keys(PIN_COLORS).map(cat => [cat, makePinDataUrl(cat)])
)
function getCategoryPinUrl(cat) {
  return CATEGORY_PIN_URLS[cat] ?? CATEGORY_PIN_URLS.default
}

function makePointLayer(IconLayer, layer) {
  if (!layer.data?.length || !layer.visible) return null
  const alpha = Math.round(layer.opacity * 255)
  const size  = layer.pointSize ?? 36
  return new IconLayer({
    id:       `point-custom-${layer.id}`,
    data:     layer.data,
    pickable: true,
    getPosition: d => [parseFloat(d.long ?? d.lng ?? 0), parseFloat(d.lat ?? 0)],
    getIcon: d => ({
      url:     getCategoryPinUrl(d.category),
      width:   48,
      height:  60,
      anchorY: 60,   // pin tip is at the bottom
    }),
    getSize:       size,
    getColor:      [255, 255, 255, alpha],  // white tint = preserve SVG colors, alpha = opacity
    sizeScale:     1,
    sizeMinPixels: 16,
    updateTriggers: { getColor: [layer.opacity], getSize: [layer.pointSize] },
  })
}

// ── Scatter / bubble layer ────────────────────────────────────────────────
function makeScatterLayer(ScatterLayer, layer) {
  if (!layer.data?.length || !layer.visible) return null
  const alpha = Math.round(layer.opacity * 255)
  return new ScatterLayer({
    id:                 `scatter-custom-${layer.id}`,
    data:               layer.data,
    pickable:           true,
    stroked:            true,
    filled:             true,
    radiusScale:        layer.radiusScale ?? 1,
    radiusMinPixels:    2,
    lineWidthMinPixels: 1,
    getPosition: d  => [parseFloat(d.long ?? d.lng ?? 0), parseFloat(d.lat ?? 0)],
    getRadius:   d  => parseFloat(d.radius ?? 0),
    getFillColor: d => d.colour
      ? [...hexColorToRgb(d.colour), alpha]
      : [59, 130, 246, alpha],           // default: blue
    getLineColor:       [255, 255, 255, 180],
    updateTriggers: { getFillColor: [layer.opacity], getRadius: [layer.radiusScale] },
  })
}

// ── Polygon / GeoJSON layer ───────────────────────────────────────────────
/**
 * Each data row must have:
 *   geo_json  – a GeoJSON geometry object or JSON string (from ST_AsGeoJSON)
 *   tooltip   – string shown on hover
 *   colour    – optional CSS hex string for fill + stroke
 */
function makePolygonLayer(GeoJsonLayer, layer) {
  if (!layer.data?.length || !layer.visible) return null

  const fillAlpha   = Math.round(layer.opacity * 0.35 * 255)   // fill is more transparent
  const strokeAlpha = Math.round(layer.opacity * 255)
  const strokeW     = layer.strokeWidth ?? 2

  // Convert rows → GeoJSON FeatureCollection
  const features = layer.data.map(row => {
    let geom = row.geo_json
    if (typeof geom === 'string') {
      try { geom = JSON.parse(geom) } catch { return null }
    }
    if (!geom) return null
    // PostGIS ST_AsGeoJSON returns a geometry — wrap it in a Feature
    if (geom.type === 'Feature') {
      return { ...geom, properties: { ...geom.properties, _colour: row.colour, _tooltip: row.tooltip } }
    }
    return { type: 'Feature', geometry: geom, properties: { _colour: row.colour, _tooltip: row.tooltip } }
  }).filter(Boolean)

  return new GeoJsonLayer({
    id:                 `polygon-custom-${layer.id}`,
    data:               { type: 'FeatureCollection', features },
    pickable:           true,
    stroked:            true,
    filled:             true,
    extruded:           false,
    lineWidthMinPixels: strokeW,
    getLineWidth:       strokeW,
    getFillColor:   f => [...hexColorToRgb(f.properties._colour ?? '#8b5cf6'), fillAlpha],
    getLineColor:   f => [...hexColorToRgb(f.properties._colour ?? '#7c3aed'), strokeAlpha],
    updateTriggers: {
      getFillColor: [layer.opacity],
      getLineColor: [layer.opacity, layer.strokeWidth],
    },
  })
}

// ── WorldCover class colours / labels ─────────────────────────────────────
const LAND_COVER_COLORS = {
  10:  [0,   100,  0],    // Tree cover
  20:  [255, 187,  34],   // Shrubland
  30:  [255, 255,  76],   // Grassland
  40:  [240, 150, 255],   // Cropland
  50:  [250,   0,   0],   // Built-up
  60:  [180, 180, 180],   // Bare / sparse
  70:  [240, 240, 240],   // Snow & ice
  80:  [0,   100, 200],   // Permanent water
  90:  [0,   150, 160],   // Herbaceous wetland
  95:  [0,   207, 117],   // Mangroves
  100: [250, 230, 160],   // Moss & lichen
}
const LAND_COVER_LABELS = {
  10: 'Tree cover', 20: 'Shrubland', 30: 'Grassland', 40: 'Cropland',
  50: 'Built-up',  60: 'Bare / sparse', 70: 'Snow & ice', 80: 'Permanent water',
  90: 'Herbaceous wetland', 95: 'Mangroves', 100: 'Moss & lichen',
}

// Population gradient: light-yellow → deep-red
function popColor(pop, maxPop, alpha) {
  const t = Math.min(pop / Math.max(maxPop, 1), 1)
  return [
    Math.round(255),
    Math.round(255 * (1 - t * 0.9)),
    Math.round(50  * (1 - t)),
    alpha,
  ]
}

/**
 * Build a deck.gl H3HexagonLayer from h3_grids data.
 * viz: 'population' | 'land_cover' | 'base'
 */
function makeGridLayer(H3Hex, data, viz, opacity, elevScale) {
  if (!data?.length) return null
  const alpha = Math.round(opacity * 255)
  const maxPop = viz === 'population'
    ? Math.max(...data.map(d => Number(d.population) || 0), 1)
    : 1

  return new H3Hex({
    id:             `h3-grid-${viz}`,
    data,
    pickable:       true,
    extruded:       viz === 'population',
    wireframe:      false,
    filled:         true,
    coverage:       0.9,
    elevationScale: viz === 'population' ? elevScale : 1,
    getHexagon:   d => d.h3_index,
    getFillColor: d => {
      if (viz === 'population') {
        const pop = Number(d.population) || 0
        return popColor(pop, maxPop, alpha)
      }
      if (viz === 'land_cover') {
        const rgb = LAND_COVER_COLORS[Number(d.dominant_class)] ?? [128, 128, 128]
        return [...rgb, alpha]
      }
      // base — solid teal
      return [34, 197, 198, alpha]
    },
    getElevation: d => viz === 'population' ? (Number(d.population) || 0) : 0,
    updateTriggers: {
      getFillColor: [viz, opacity, maxPop],
      getElevation: [viz],
    },
  })
}

/** Route to the correct layer factory based on layerType */
function makeCustomLayer(r, layer) {
  if (layer.layerType === 'point')   return makePointLayer(r.IconLayer, layer)
  if (layer.layerType === 'scatter') return makeScatterLayer(r.ScatterplotLayer, layer)
  if (layer.layerType === 'polygon') return makePolygonLayer(r.GeoJsonLayer, layer)
  return makeHexLayer(r.H3HexagonLayer, layer)
}

// ── App ───────────────────────────────────────────────────────────────────
export default function App() {
  const mapRef  = useRef(null)
  const [ready, setReady]   = useState(false)
  const [h3Data, setH3Data] = useState(null)

  // Layer controls
  const [extruded,       setExtruded]       = useState(true)
  const [wireframe,      setWireframe]      = useState(false)
  const [coverage,       setCoverage]       = useState(1)
  const [elevationScale, setElevationScale] = useState(20)

  // Drawing state
  const [drawMode,      setDrawMode]      = useState(false)
  const [polygonPoints, setPolygonPoints] = useState([])   // [[lng,lat], …]
  const [isComplete,    setIsComplete]    = useState(false)
  const [selectedCells, setSelectedCells] = useState(new Set())
  const [cursorPos,     setCursorPos]     = useState(null)

  // DB update state (for polygon selection)
  const [updateCount,  setUpdateCount]  = useState(0)
  const [updateStatus, setUpdateStatus] = useState('idle') // idle|loading|success|error

  // CSV upload state
  const [csvData,         setCsvData]         = useState(null)   // [{hex,count},…]
  const [csvFileName,     setCsvFileName]     = useState(null)
  const [csvError,        setCsvError]        = useState(null)
  const [csvImportStatus, setCsvImportStatus] = useState('idle') // idle|loading|success|error
  const csvInputRef = useRef(null)

  // ── Custom query-driven layers ────────────────────────────────────────
  // Each layer: { id, name, query, data, loading, error,
  //               visible, opacity, coverage, elevationScale, expanded }
  const [customLayers, setCustomLayers] = useState([])

  // Add / edit layer modal state
  const [showAddModal,   setShowAddModal]   = useState(false)
  const [editingLayerId, setEditingLayerId] = useState(null)  // null = add mode, id = edit mode
  const [newLayerName,   setNewLayerName]   = useState('')
  const [newLayerQuery,  setNewLayerQuery]  = useState('')
  const [addLoading,     setAddLoading]     = useState(false)
  const [addError,       setAddError]       = useState(null)

  // Sidebar collapse
  const [panelOpen, setPanelOpen] = useState(true)

  // Drag-to-reorder
  const dragLayerIdRef      = useRef(null)
  const dragFromHandleRef   = useRef(false)   // true only when drag starts from the grip

  // ── Grid Explorer state ──────────────────────────────────────────────
  const [gridData,      setGridData]      = useState(null)
  const [gridLoading,   setGridLoading]   = useState(false)
  const [gridError,     setGridError]     = useState(null)
  const [gridViz,       setGridViz]       = useState('population')
  const [gridOpacity,   setGridOpacity]   = useState(0.8)
  const [gridElevScale, setGridElevScale] = useState(1)
  const [gridVisible,   setGridVisible]   = useState(true)
  const [dataStale,     setDataStale]     = useState(false)  // polygon reshaped after last fetch

  // ── Bound GeoJSON — normalised geometry used for all 3 data queries ───
  const [boundGeoJSON, setBoundGeoJSON] = useState(null)
  // boundMeta: { type: 'polygon'|'pincodes'|'circles', values?: string[] }
  // When type is pincodes/circles, server-side endpoints are used to avoid
  // sending large geometry payloads over the network.
  const [boundMeta, setBoundMeta] = useState(null)

  // ── Points layer state ────────────────────────────────────────────────
  const [pointsData,     setPointsData]     = useState(null)
  const [pointsLoading,  setPointsLoading]  = useState(false)
  const [pointsError,    setPointsError]    = useState(null)
  const [pointsVisible,  setPointsVisible]  = useState(true)
  const [pointsOpacity,  setPointsOpacity]  = useState(0.85)
  const [pointsPinSize,  setPointsPinSize]  = useState(36)
  const [enabledCategories, setEnabledCategories] = useState(null)   // null = all

  // ── Polygons layer state ──────────────────────────────────────────────
  const [polygonsData,        setPolygonsData]        = useState(null)
  const [polygonsLoading,     setPolygonsLoading]     = useState(false)
  const [polygonsError,       setPolygonsError]       = useState(null)
  const [polygonsVisible,     setPolygonsVisible]     = useState(true)
  const [polygonsOpacity,     setPolygonsOpacity]     = useState(0.7)
  const [polygonsStrokeWidth, setPolygonsStrokeWidth] = useState(1.5)
  const [enabledPolygonTypes, setEnabledPolygonTypes] = useState(null) // null = all

  // ── Section collapse state (false = collapsed, no auto-load on bound change) ──
  const [gridOpen,     setGridOpen]     = useState(false)
  const [pointsOpen,   setPointsOpen]   = useState(false)
  const [polygonsOpen, setPolygonsOpen] = useState(false)
  const [sqlOpen,      setSqlOpen]      = useState(true)   // SQL always open (no data fetch)

  // ── Bound Area state ──────────────────────────────────────────────────
  const [boundMode,          setBoundMode]          = useState('draw')  // 'draw'|'pincode'|'circle'|'custom'|'sql'
  const [pincodeInput,       setPincodeInput]       = useState('')
  const [customPolygonText,  setCustomPolygonText]  = useState('')
  const [customPolygonError, setCustomPolygonError] = useState(null)
  const [sqlBoundQuery,      setSqlBoundQuery]      = useState('')
  const [sqlBoundError,      setSqlBoundError]      = useState(null)
  const [boundLoading,       setBoundLoading]       = useState(false)
  const [boundError,         setBoundError]         = useState(null)

  // ── Base layer state ─────────────────────────────────────────────────
  const [activeBaseLayer,  setActiveBaseLayer]  = useState('positron')
  const [styleVersion,     setStyleVersion]     = useState(0)
  const [layerPickerOpen,  setLayerPickerOpen]  = useState(false)
  const layerPickerRef = useRef(null)

  // ── Search state ─────────────────────────────────────────────────────
  const [searchQuery,  setSearchQuery]  = useState('')
  const [searchResult, setSearchResult] = useState(null)  // { type, …data }
  const [searchStatus, setSearchStatus] = useState('idle') // idle|loading|error
  const [searchError,  setSearchError]  = useState(null)
  const searchMarkerRef = useRef(null)

  // ── Pincode boundaries state ──────────────────────────────────────────
  const [circleInput,       setCircleInput]       = useState('')
  const [pincodeBoundaries, setPincodeBoundaries] = useState(null)
  const [pincodeStatus,     setPincodeStatus]     = useState('idle')  // idle|loading|success|error
  const [pincodeError,      setPincodeError]      = useState(null)

  // ── Vertex deletion state ─────────────────────────────────────────────
  const [selectedVertexIdx, setSelectedVertexIdx] = useState(null)
  const selectedVertexIdxRef = useRef(null)

  // ── Refs for stable access inside map event handlers ──────────────────
  const drawModeRef      = useRef(false)
  const isCompleteRef    = useRef(false)
  const polygonPointsRef = useRef([])
  const h3ResolutionRef  = useRef(9)           // default resolution = 9
  const dragIndexRef     = useRef(-1)          // -1 = not dragging
  const optsRef          = useRef({ extruded, wireframe, coverage, elevationScale })

  useEffect(() => { drawModeRef.current   = drawMode   }, [drawMode])
  useEffect(() => { isCompleteRef.current = isComplete }, [isComplete])
  useEffect(() => { polygonPointsRef.current = polygonPoints }, [polygonPoints])
  useEffect(() => { optsRef.current = { extruded, wireframe, coverage, elevationScale } })

  // ── Load H3 data ──────────────────────────────────────────────────────
  // const loadH3Data = useRef([])
  const loadH3Data = useCallback(() =>
    fetchH3Cells().then(data => {
      setH3Data(data)
      if (data?.length && window.h3)
        h3ResolutionRef.current = window.h3.h3GetResolution(data[0].hex)
    }).catch(console.error), [])

  // H3 data is loaded on demand — not auto-fetched on mount

  // ── Polyfill helper (pure-ref, safe inside any closure) ───────────────
  const doPolyfill = useCallback(() => {
    const pts = polygonPointsRef.current
    if (pts.length < 3 || !window.h3) return
    const cells = window.h3.polyfill(pts, h3ResolutionRef.current, true)
    setSelectedCells(new Set(cells))
  }, [])

  // ── Finish drawing ────────────────────────────────────────────────────
  const finishDrawing = useCallback(() => {
    if (polygonPointsRef.current.length < 3) return
    setIsComplete(true)
    setDrawMode(false)
    setCursorPos(null)
  }, [])

  // ── Clear everything ──────────────────────────────────────────────────
  const clearSelection = useCallback(() => {
    // ── Immediately wipe the map overlays via refs ──────────────────────
    // Don't wait for React state → useEffect cycle; clear the map sources
    // directly so the visual disappears on the same frame as the click.
    const map = mapRef.current?.map
    if (map) {
      // Pincode / circle bound outline (purple polygon)
      map.getSource('pincode-source')?.setData(EMPTY_FC)
      // Drawn polygon sources
      map.getSource('sel-polygon')  ?.setData(EMPTY_FEAT({ type: 'Polygon', coordinates: [[]] }))
      map.getSource('sel-outline')  ?.setData(EMPTY_FC)
      map.getSource('sel-vertices') ?.setData(EMPTY_FC)
      map.getSource('sel-midpoints')?.setData(EMPTY_FC)
    }
    // Drawing state
    polygonPointsRef.current = []
    setPolygonPoints([])
    setSelectedCells(new Set())
    setIsComplete(false)
    setDrawMode(false)
    setCursorPos(null)
    setUpdateStatus('idle')
    setSelectedVertexIdx(null)
    // Data layers
    setGridData(null)
    setGridError(null)
    setGridLoading(false)
    setDataStale(false)
    setPointsData(null)
    setPointsError(null)
    setPointsLoading(false)
    setPolygonsData(null)
    setPolygonsError(null)
    setPolygonsLoading(false)
    setEnabledCategories(null)
    setEnabledPolygonTypes(null)
    // Bound state
    setBoundGeoJSON(null)
    setBoundMeta(null)
    setBoundError(null)
    setPincodeBoundaries(null)
    // Reset all mode inputs
    setPincodeInput('')
    setCircleInput('')
    setCustomPolygonText('')
    setCustomPolygonError(null)
    setSqlBoundError(null)
    // Note: sqlBoundQuery intentionally NOT cleared so user can re-run/edit
  }, [])

  // ── Delete a polygon vertex ───────────────────────────────────────────
  const deleteVertex = useCallback(() => {
    const idx = selectedVertexIdxRef.current
    if (idx === null) return
    const pts = polygonPointsRef.current
    if (pts.length <= 3) return
    const next = [...pts]
    next.splice(idx, 1)
    polygonPointsRef.current = next
    setPolygonPoints(next)
    setSelectedVertexIdx(null)
  }, [])

  // ── Update DB ─────────────────────────────────────────────────────────
  const handleUpdateDB = useCallback(async () => {
    setUpdateStatus('loading')
    try {
      await updateH3Cells(selectedCells, updateCount)
      setUpdateStatus('success')
      await loadH3Data()                          // refresh base layer data
      setTimeout(() => setUpdateStatus('idle'), 3000)
    } catch {
      setUpdateStatus('error')
      setTimeout(() => setUpdateStatus('idle'), 3000)
    }
  }, [selectedCells, updateCount, loadH3Data])

  // ── Per-section fetch helpers ─────────────────────────────────────────
  // Each accepts optional (geoJSON, meta) overrides; falls back to current state.
  // meta.type: 'pincodes' | 'circles' | 'polygon' | 'all' | 'sql'

  const fetchGridData = useCallback((geoJSON, meta) => {
    const g = geoJSON ?? boundGeoJSON
    const m = meta    ?? boundMeta
    if (!g && m?.type !== 'all') return
    setGridLoading(true); setGridError(null); setGridData(null)
    const p = m?.type === 'all'
      ? fetchAllH3Grids()
      : (m?.type === 'pincodes' || m?.type === 'circles')
        ? fetchH3GridsByBound(m.type, m.values)
        : fetchH3GridsByPolygon(g)
    p.then(rows => setGridData(rows))
     .catch(err  => setGridError(err.message))
     .finally(() => setGridLoading(false))
  }, [boundGeoJSON, boundMeta])

  const fetchPointsData = useCallback((geoJSON, meta) => {
    const g = geoJSON ?? boundGeoJSON
    const m = meta    ?? boundMeta
    if (!g && m?.type !== 'all') return
    setPointsLoading(true); setPointsError(null); setPointsData(null)
    const p = m?.type === 'all'
      ? fetchAllPoints()
      : (m?.type === 'pincodes' || m?.type === 'circles')
        ? fetchPointsByBound(m.type, m.values)
        : fetchPointsByPolygon(g)
    p.then(rows => { setPointsData(rows); setEnabledCategories(null) })
     .catch(err  => setPointsError(err.message))
     .finally(() => setPointsLoading(false))
  }, [boundGeoJSON, boundMeta])

  const fetchPolygonsData = useCallback((geoJSON, meta) => {
    const g = geoJSON ?? boundGeoJSON
    const m = meta    ?? boundMeta
    if (!g && m?.type !== 'all') return
    setPolygonsLoading(true); setPolygonsError(null); setPolygonsData(null)
    const p = m?.type === 'all'
      ? fetchAllPolygons()
      : (m?.type === 'pincodes' || m?.type === 'circles')
        ? fetchPolygonsByBound(m.type, m.values)
        : fetchPolygonsByPolygon(g)
    p.then(rows => { setPolygonsData(rows); setEnabledPolygonTypes(null) })
     .catch(err  => setPolygonsError(err.message))
     .finally(() => setPolygonsLoading(false))
  }, [boundGeoJSON, boundMeta])

  // Auto-fetch when draw-mode polygon completes
  useEffect(() => {
    if (isComplete && polygonPoints.length >= 3) {
      const geo = {
        type: 'Polygon',
        coordinates: [[...polygonPoints.map(([lng, lat]) => [lng, lat]), polygonPoints[0]]],
      }
      setBoundMeta({ type: 'polygon' })
      setBoundGeoJSON(geo)
    }
  }, [isComplete]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh custom query layers that have "Clip to bound" enabled
  useEffect(() => {
    if (!boundGeoJSON) return
    customLayers
      .filter(l => l.boundFilter && !l.loading)
      .forEach(l => refreshLayer(l.id))
  }, [boundGeoJSON]) // eslint-disable-line react-hooks/exhaustive-deps

  // Mark data stale when draw polygon is reshaped after a successful fetch
  useEffect(() => {
    if ((gridData || pointsData || polygonsData) && isComplete && polygonPoints.length >= 3) setDataStale(true)
  }, [polygonPoints]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch only sections that already have data (polygon was reshaped after a load)
  const handleRefetchAll = useCallback(() => {
    if (!polygonPoints.length) return
    const geo = {
      type: 'Polygon',
      coordinates: [[...polygonPoints.map(([lng, lat]) => [lng, lat]), polygonPoints[0]]],
    }
    setBoundGeoJSON(geo)
    setDataStale(false)
    // Only re-fetch sections the user had previously loaded
    if (gridData)     fetchGridData(geo, boundMeta)
    if (pointsData)   fetchPointsData(geo, boundMeta)
    if (polygonsData) fetchPolygonsData(geo, boundMeta)
  }, [polygonPoints, boundMeta, gridData, pointsData, polygonsData, fetchGridData, fetchPointsData, fetchPolygonsData])

  // Apply one or more pincodes (comma-separated) as the active bound
  const applyPincodeBound = useCallback(async () => {
    const codes = pincodeInput.split(',').map(s => s.trim()).filter(Boolean)
    if (!codes.length) return
    setBoundLoading(true)
    setBoundError(null)
    try {
      const geom = await fetchBoundGeometry('pincodes', codes)
      // Show outline on map via pincode-source layer
      const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: geom, properties: {} }] }
      setPincodeBoundaries(fc)
      // Fit map to bounds
      const bounds = getGeoJSONBounds(fc)
      mapRef.current?.map?.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 1200 })
      // Set meta so fetchAllData uses the server-side endpoint (no large payload)
      setBoundMeta({ type: 'pincodes', values: codes })
      setBoundGeoJSON(geom)
    } catch (err) {
      setBoundError(err.message)
    } finally {
      setBoundLoading(false)
    }
  }, [pincodeInput])

  // Apply pasted GeoJSON/coordinates as the active polygon
  const applyCustomPolygon = useCallback(() => {
    setCustomPolygonError(null)
    try {
      const geo = JSON.parse(customPolygonText.trim())
      let coords
      if      (geo.type === 'Polygon')                                  coords = geo.coordinates[0]
      else if (geo.type === 'Feature' && geo.geometry?.type === 'Polygon') coords = geo.geometry.coordinates[0]
      else if (geo.type === 'MultiPolygon')                             coords = geo.coordinates[0][0]
      else if (Array.isArray(geo))                                      coords = geo
      else throw new Error('Expected GeoJSON Polygon, Feature, or [[lng,lat],…] array')
      if (coords.length < 3) throw new Error('Polygon needs at least 3 points')
      const pts = coords.map(([lng, lat]) => [lng, lat])
      polygonPointsRef.current = pts
      setPolygonPoints(pts)
      setIsComplete(true)
      const lngs = pts.map(([lng]) => lng), lats = pts.map(([, lat]) => lat)
      mapRef.current?.map?.fitBounds(
        [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
        { padding: 60, maxZoom: 13, duration: 1200 }
      )
      setBoundMeta({ type: 'polygon' })
      setBoundGeoJSON({ type: 'Polygon', coordinates: [[...pts, pts[0]]] })
    } catch (err) {
      setCustomPolygonError(err.message)
    }
  }, [customPolygonText])

  // ── CSV handlers ─────────────────────────────────────────────────────
  const handleCsvUpload = useCallback((e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setCsvError(null)
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const rows = parseCSV(ev.target.result)
        setCsvData(rows)
        setCsvFileName(file.name)
        setCsvImportStatus('idle')
      } catch (err) {
        setCsvError(err.message)
        setCsvData(null)
      }
      e.target.value = ''           // allow re-upload of the same file
    }
    reader.readAsText(file)
  }, [])

  const handleCsvImport = useCallback(async () => {
    if (!csvData?.length) return
    setCsvImportStatus('loading')
    try {
      await importH3Cells(csvData)
      setCsvImportStatus('success')
      await loadH3Data()            // refresh base layer
      setTimeout(() => setCsvImportStatus('idle'), 3000)
    } catch {
      setCsvImportStatus('error')
      setTimeout(() => setCsvImportStatus('idle'), 3000)
    }
  }, [csvData, loadH3Data])

  const clearCsvData = useCallback(() => {
    setCsvData(null)
    setCsvFileName(null)
    setCsvError(null)
    setCsvImportStatus('idle')
  }, [])

  // ── Base layer switcher ───────────────────────────────────────────────
  const handleBaseLayerChange = useCallback((layer) => {
    setActiveBaseLayer(layer.id)
    mapRef.current?.map?.setStyle(layer.url)
  }, [])

  // ── Search handlers ───────────────────────────────────────────────────
  const handleSearch = useCallback(async () => {
    const q = searchQuery.trim()
    if (!q) return

    const detected = detectSearchType(q)
    setSearchResult(null)
    setSearchError(null)

    if (!detected || detected.type === 'unknown') {
      setSearchError('Could not detect type — try lat,lng / H3 index / 6-digit pincode')
      return
    }

    const map = mapRef.current?.map

    if (detected.type === 'latlng') {
      const { lat, lng } = detected
      setSearchResult({ type: 'latlng', lat, lng })
      map?.flyTo({ center: [lng, lat], zoom: 14, duration: 1200 })
      return
    }

    if (detected.type === 'h3') {
      const { index } = detected
      const geojson  = h3ToSearchGeoJSON(index)
      const res      = window.h3.h3GetResolution(index)
      const [clat, clng] = window.h3.h3ToGeo(index)
      setSearchResult({ type: 'h3', index, resolution: res, geojson })
      map?.flyTo({ center: [clng, clat], zoom: H3_RES_ZOOM[res] ?? 13, duration: 1200 })
      return
    }

    if (detected.type === 'pincode') {
      setSearchStatus('loading')
      try {
        const data = await fetchPincodeByCode(detected.pincode)
        if (!data.features.length) {
          setSearchError(`Pincode ${detected.pincode} not found in DB`)
          setSearchStatus('idle')
          return
        }
        const bounds = getGeoJSONBounds(data)
        setSearchResult({ type: 'pincode', pincode: detected.pincode, geojson: data })
        map?.fitBounds(bounds, { padding: 80, maxZoom: 14, duration: 1200 })
        setSearchStatus('idle')
      } catch (err) {
        setSearchError(err.message)
        setSearchStatus('idle')
      }
    }
  }, [searchQuery])

  const clearSearch = useCallback(() => {
    setSearchQuery('')
    setSearchResult(null)
    setSearchError(null)
    setSearchStatus('idle')
  }, [])

  // ── Circle bound handler ──────────────────────────────────────────────
  const applyCircleBound = useCallback(async () => {
    const circles = circleInput.split(',').map(s => s.trim()).filter(Boolean)
    if (!circles.length) return
    setBoundLoading(true)
    setBoundError(null)
    try {
      const geom = await fetchBoundGeometry('circles', circles)
      // Show outline on map
      const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: geom, properties: {} }] }
      setPincodeBoundaries(fc)
      const bounds = getGeoJSONBounds(fc)
      mapRef.current?.map?.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 1200 })
      // Set meta so fetchAllData uses the server-side endpoint (no large payload)
      setBoundMeta({ type: 'circles', values: circles })
      setBoundGeoJSON(geom)
    } catch (err) {
      setBoundError(err.message)
    } finally {
      setBoundLoading(false)
    }
  }, [circleInput])

  const clearPincodeBoundaries = useCallback(() => {
    setPincodeBoundaries(null)
    setPincodeStatus('idle')
    setPincodeError(null)
  }, [])

  // ── SQL Bound handler ─────────────────────────────────────────────────
  const applySQLBound = useCallback(async () => {
    const q = sqlBoundQuery.trim()
    if (!q) return
    setSqlBoundError(null)
    setBoundLoading(true)
    setBoundError(null)
    try {
      const geom = await fetchBoundGeometrySQL(q)
      // Show the unioned geometry as the bound outline on the map
      const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: geom, properties: {} }] }
      setPincodeBoundaries(fc)
      // Fit map to the result
      const bounds = getGeoJSONBounds(fc)
      mapRef.current?.map?.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 1200 })
      // Store as a polygon-type bound so fetchAllData uses the geometry path
      setBoundMeta({ type: 'sql', query: q })
      setBoundGeoJSON(geom)
    } catch (err) {
      setSqlBoundError(err.message)
    } finally {
      setBoundLoading(false)
    }
  }, [sqlBoundQuery])

  // ── Load all data with no spatial filter ──────────────────────────────
  const loadAllData = useCallback(() => {
    // Clear any bound visuals from the map immediately
    const map = mapRef.current?.map
    if (map) {
      map.getSource('pincode-source')?.setData(EMPTY_FC)
      map.getSource('sel-polygon')  ?.setData(EMPTY_FEAT({ type: 'Polygon', coordinates: [[]] }))
      map.getSource('sel-outline')  ?.setData(EMPTY_FC)
      map.getSource('sel-vertices') ?.setData(EMPTY_FC)
      map.getSource('sel-midpoints')?.setData(EMPTY_FC)
    }
    polygonPointsRef.current = []
    setPolygonPoints([])
    setIsComplete(false)
    setDrawMode(false)
    setPincodeBoundaries(null)
    setBoundGeoJSON(null)           // no polygon outline needed
    setBoundMeta({ type: 'all' })
    // Clear any existing data so each section shows its Load button
    setGridData(null);    setGridError(null);    setGridLoading(false)
    setPointsData(null);  setPointsError(null);  setPointsLoading(false)
    setPolygonsData(null); setPolygonsError(null); setPolygonsLoading(false)
    // Expand sections so the Load buttons are visible — user picks what to fetch
    setGridOpen(true); setPointsOpen(true); setPolygonsOpen(true)
  }, [])

  // ── Custom layer helpers ──────────────────────────────────────────────
  const updateLayer = useCallback((id, updates) =>
    setCustomLayers(prev => prev.map(l => l.id === id ? { ...l, ...updates } : l)),
  [])

  const deleteLayer = useCallback((id) =>
    setCustomLayers(prev => prev.filter(l => l.id !== id)),
  [])

  // Run the query for an existing layer and refresh its data.
  // forceClip:
  //   undefined  → auto-decide from layer.boundFilter (used by auto-refresh effect)
  //   null       → explicitly no clip (fetch all data)
  //   object     → use this exact clip (avoids stale-closure bug when toggling)
  const refreshLayer = useCallback(async (id, forceClip = undefined) => {
    updateLayer(id, { loading: true, error: null })
    try {
      const layer = customLayers.find(l => l.id === id)
      let clip
      if (forceClip !== undefined) {
        clip = forceClip   // null = no clip, object = explicit clip
      } else if (layer.boundFilter && (boundMeta || boundGeoJSON)) {
        clip = { boundMeta, boundPolygon: boundGeoJSON }
      }
      const data = await fetchQueryLayer(layer.query, clip ?? undefined)
      updateLayer(id, { data, loading: false })
    } catch (err) {
      updateLayer(id, { error: err.message, loading: false })
    }
  }, [customLayers, updateLayer, boundMeta, boundGeoJSON])

  // Open modal for adding a new layer
  const openAddModal = useCallback(() => {
    setEditingLayerId(null)
    setNewLayerName('')
    setNewLayerQuery('')
    setAddError(null)
    setShowAddModal(true)
  }, [])

  // Open modal pre-filled for editing an existing layer
  const openEditModal = useCallback((layer) => {
    setEditingLayerId(layer.id)
    setNewLayerName(layer.name)
    setNewLayerQuery(layer.query)
    setAddError(null)
    setShowAddModal(true)
  }, [])

  // Run query — adds a new layer or updates an existing one
  const handleAddLayer = useCallback(async () => {
    if (!newLayerQuery.trim()) return
    setAddLoading(true)
    setAddError(null)
    try {
      const data      = await fetchQueryLayer(newLayerQuery)
      const layerType = detectLayerType(data)
      if (editingLayerId) {
        // Edit mode: update name, query, re-fetched data, and re-detected type
        setCustomLayers(prev => prev.map(l =>
          l.id === editingLayerId
            ? { ...l, name: newLayerName.trim() || l.name, query: newLayerQuery, data, layerType, error: null }
            : l
        ))
      } else {
        // Add mode
        const id = Date.now().toString()
        setCustomLayers(prev => [...prev, {
          id,
          name:           newLayerName.trim() || `Layer ${prev.length + 1}`,
          query:          newLayerQuery,
          data,
          layerType,
          loading:        false,
          error:          null,
          visible:        true,
          opacity:        0.85,
          coverage:       1,
          elevationScale: 1,
          pointSize:      36,
          radiusScale:    1,
          strokeWidth:    2,
          expanded:       false,
          boundFilter:    false,
        }])
      }
      setShowAddModal(false)
      setNewLayerName('')
      setNewLayerQuery('')
      setEditingLayerId(null)
    } catch (err) {
      setAddError(err.message)
    } finally {
      setAddLoading(false)
    }
  }, [editingLayerId, newLayerName, newLayerQuery])

  // Drag-to-reorder handlers
  const handleLayerDragStart = useCallback((e, id) => {
    dragLayerIdRef.current = id
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleLayerDragOver = useCallback((e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleLayerDrop = useCallback((e, targetId) => {
    e.preventDefault()
    const sourceId = dragLayerIdRef.current
    if (!sourceId || sourceId === targetId) return
    setCustomLayers(prev => {
      const arr   = [...prev]
      const srcI  = arr.findIndex(l => l.id === sourceId)
      const tgtI  = arr.findIndex(l => l.id === targetId)
      const [item] = arr.splice(srcI, 1)
      arr.splice(tgtI, 0, item)
      return arr
    })
    dragLayerIdRef.current = null
  }, [])

  // ── Close layer picker on outside click ──────────────────────────────
  useEffect(() => {
    if (!layerPickerOpen) return
    const handler = (e) => {
      if (!layerPickerRef.current?.contains(e.target)) setLayerPickerOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [layerPickerOpen])

  // ── Bootstrap: MapLibre + deck.gl overlay ────────────────────────────
  useEffect(() => {
    let attempts = 0
    let mapDiv = null, map = null

    const init = () => {
      const d   = window.deck
      const mgl = window.maplibregl
      if (!d?.H3HexagonLayer || !d?.MapboxOverlay || !mgl) {
        if (++attempts < 120) { setTimeout(init, 100); return }
        return
      }

      const { H3HexagonLayer, ScatterplotLayer, IconLayer, GeoJsonLayer, MapboxOverlay } = d

      mapDiv = document.createElement('div')
      Object.assign(mapDiv.style, { position:'fixed', inset:'0', width:'100%', height:'100%', zIndex:'0' })
      document.body.appendChild(mapDiv)

      map = new mgl.Map({
        container: mapDiv, style: BASE_LAYERS[0].url,
        center: [73.7381, 18.5913], zoom: 11, pitch: 30, bearing: 0,
        maxZoom: 20, antialias: true,
      })
      map.addControl(new mgl.NavigationControl(), 'top-left')

      // ── Named layer-event handlers ─────────────────────────────────
      // Defined here so the same function reference is used for on/off,
      // preventing duplicate registration when setupLayers() is called again.
      const onMidpointDown = (e) => {
        if (!isCompleteRef.current) return
        e.preventDefault()
        const feats = map.queryRenderedFeatures(e.point, { layers: ['sel-midpoints-circles'] })
        if (!feats.length) return
        const edgeIdx = feats[0].properties.edgeIndex
        const { lng, lat } = e.lngLat
        setPolygonPoints(prev => {
          const next = [...prev]
          next.splice(edgeIdx + 1, 0, [lng, lat])
          polygonPointsRef.current = next
          return next
        })
        dragIndexRef.current = edgeIdx + 1
        map.dragPan.disable()
        map.getCanvas().style.cursor = 'grabbing'
      }
      const onMidpointEnter = () => {
        if (isCompleteRef.current && dragIndexRef.current < 0)
          map.getCanvas().style.cursor = 'cell'
      }
      const onMidpointLeave = () => {
        if (isCompleteRef.current && dragIndexRef.current < 0)
          map.getCanvas().style.cursor = ''
      }
      const onVertexDown = (e) => {
        if (!isCompleteRef.current) return
        e.preventDefault()
        const feats = map.queryRenderedFeatures(e.point, { layers: ['sel-vertices-circles'] })
        if (!feats.length) return
        dragIndexRef.current = feats[0].properties.index
        map.dragPan.disable()
        map.getCanvas().style.cursor = 'grabbing'
      }
      const onVertexEnter = () => {
        if (isCompleteRef.current) map.getCanvas().style.cursor = 'grab'
      }
      const onVertexLeave = () => {
        if (isCompleteRef.current && dragIndexRef.current < 0)
          map.getCanvas().style.cursor = ''
      }

      // ── Sources + layers + layer-specific events ───────────────────
      // Called on initial load AND after every setStyle() so custom
      // sources/layers (which get wiped on style change) are restored.
      const setupLayers = () => {
        // Search result (amber) — lowest z-order of custom layers
        map.addSource('search-result-source', { type: 'geojson', data: EMPTY_FC })
        map.addLayer({ id: 'search-result-fill', type: 'fill', source: 'search-result-source',
          paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.2 } })
        map.addLayer({ id: 'search-result-outline', type: 'line', source: 'search-result-source',
          paint: { 'line-color': '#d97706', 'line-width': 2.5 } })

        // Pincode boundaries (purple)
        map.addSource('pincode-source', { type: 'geojson', data: EMPTY_FC })
        map.addLayer({ id: 'pincode-fill', type: 'fill', source: 'pincode-source',
          paint: { 'fill-color': '#8b5cf6', 'fill-opacity': 0.12 } })
        map.addLayer({ id: 'pincode-outline', type: 'line', source: 'pincode-source',
          paint: { 'line-color': '#7c3aed', 'line-width': 1.5 } })
        map.addLayer({ id: 'pincode-labels', type: 'symbol', source: 'pincode-source',
          layout: {
            'text-field': ['get', 'pincode'], 'text-size': 11,
            'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
            'text-anchor': 'center',
          },
          paint: { 'text-color': '#5b21b6', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } })

        // Drawing polygon (sky-blue)
        map.addSource('sel-polygon', { type: 'geojson', data: EMPTY_FC })
        map.addLayer({ id: 'sel-polygon-fill', type: 'fill', source: 'sel-polygon',
          paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.15 } })
        map.addSource('sel-outline', { type: 'geojson', data: EMPTY_FC })
        map.addLayer({ id: 'sel-outline-line', type: 'line', source: 'sel-outline',
          paint: { 'line-color': '#38bdf8', 'line-width': 2, 'line-dasharray': [4, 3] } })
        map.addSource('sel-vertices', { type: 'geojson', data: EMPTY_FC })
        map.addLayer({ id: 'sel-vertices-circles', type: 'circle', source: 'sel-vertices',
          paint: {
            'circle-radius': 7, 'circle-color': '#38bdf8',
            'circle-stroke-width': 2, 'circle-stroke-color': '#fff',
          } })
        map.addSource('sel-midpoints', { type: 'geojson', data: EMPTY_FC })
        map.addLayer({ id: 'sel-midpoints-circles', type: 'circle', source: 'sel-midpoints',
          paint: {
            'circle-radius': 5, 'circle-color': '#ffffff',
            'circle-stroke-width': 2, 'circle-stroke-color': '#38bdf8',
          } })

        // Layer-specific events are cleared by setStyle() — re-register each time
        map.on('mousedown', 'sel-midpoints-circles', onMidpointDown)
        map.on('mouseenter', 'sel-midpoints-circles', onMidpointEnter)
        map.on('mouseleave', 'sel-midpoints-circles', onMidpointLeave)
        map.on('mousedown',  'sel-vertices-circles',  onVertexDown)
        map.on('mouseenter', 'sel-vertices-circles',  onVertexEnter)
        map.on('mouseleave', 'sel-vertices-circles',  onVertexLeave)
      }

      // style.load fires BEFORE load on initial startup, then again on every
      // setStyle() call. We only want setupLayers() to run after the map has
      // finished its first load, so we gate on this flag.
      let layersInitialized = false

      map.on('load', () => {
        setupLayers()
        layersInitialized = true
      })

      // On every subsequent style swap (setStyle()): re-add layers and
      // bump styleVersion so React data-sync effects re-push their data.
      map.on('style.load', () => {
        if (!layersInitialized) return   // skip the initial style.load (before map.on('load'))
        setupLayers()
        setStyleVersion(v => v + 1)
      })

      // ── Map-level pointer events (survive style changes) ──────────
      map.on('click', (e) => {
        if (!drawModeRef.current) return
        const { lng, lat } = e.lngLat
        setPolygonPoints(prev => {
          const next = [...prev, [lng, lat]]
          polygonPointsRef.current = next
          return next
        })
      })

      map.on('dblclick', (e) => {
        if (!drawModeRef.current) return
        e.preventDefault()
        finishDrawing()
      })

      map.on('mousemove', (e) => {
        const { lng, lat } = e.lngLat
        if (drawModeRef.current) setCursorPos([lng, lat])
        if (dragIndexRef.current >= 0) {
          setPolygonPoints(prev => {
            const next = [...prev]
            next[dragIndexRef.current] = [lng, lat]
            polygonPointsRef.current = next
            if (selectedVertexIdxRef.current === dragIndexRef.current)
              setSelectedVertexIdx(dragIndexRef.current)
            return next
          })
        }
      })

      map.on('mouseup', () => {
        if (dragIndexRef.current < 0) return
        dragIndexRef.current = -1
        map.dragPan.enable()
        map.getCanvas().style.cursor = ''
      })

      // ── deck.gl overlay ───────────────────────────────────────────
      const overlay = new MapboxOverlay({
        interleaved: false,
        getTooltip: ({ object, layer }) => {
          if (!object) return null
          if (layer?.id?.startsWith('point-custom-'))
            return {
              html: `<strong style="font-size:12px">${object.name ?? ''}</strong>` +
                    `<div style="font-size:11px;color:#9ca3af;margin-top:2px">${object.category ?? ''}</div>`,
              style: { background:'#1e293b', color:'#f1f5f9', borderRadius:'6px',
                       padding:'6px 10px', border:'1px solid #334155' },
            }
          if (layer?.id?.startsWith('polygon-custom-') && object?.properties?._tooltip)
            return {
              html: `<div style="font-size:12px">${object.properties._tooltip}</div>`,
              style: { background:'#1e293b', color:'#f1f5f9', borderRadius:'6px',
                       padding:'6px 10px', border:'1px solid #334155', maxWidth:'220px' },
            }
          if (layer?.id?.startsWith('scatter-custom-'))
            return {
              html: `<div style="font-size:11px">radius: <strong>${parseFloat(object.radius ?? 0).toLocaleString()}</strong></div>` +
                    (object.colour ? `<div style="font-size:10px;color:#9ca3af;margin-top:2px">${object.colour}</div>` : ''),
              style: { background:'#1e293b', color:'#f1f5f9', borderRadius:'6px',
                       padding:'6px 10px', border:'1px solid #334155' },
            }
          if (layer?.id?.startsWith('h3-custom-'))
            return `${object.hex}  height: ${(object.height ?? 0).toLocaleString()}`
          if (layer?.id?.startsWith('h3-grid-'))
            return {
              html: [
                `<div style="font-size:11px;font-weight:600;color:#f1f5f9;margin-bottom:4px">${object.h3_index}</div>`,
                object.city    ? `<div style="font-size:10px;color:#94a3b8">${[object.city, object.state].filter(Boolean).join(', ')}</div>` : '',
                object.pincode ? `<div style="font-size:10px;color:#94a3b8">Pincode: ${object.pincode}</div>` : '',
                `<div style="font-size:10px;color:#94a3b8;margin-top:3px">Population: <strong style="color:#fbbf24">${Number(object.population||0).toLocaleString()}</strong></div>`,
                `<div style="font-size:10px;color:#94a3b8">Land cover: <strong style="color:#6ee7b7">${LAND_COVER_LABELS[Number(object.dominant_class)] ?? object.dominant_class ?? '—'}</strong></div>`,
              ].join(''),
              style: { background:'#1e293b', color:'#f1f5f9', borderRadius:'6px',
                       padding:'8px 10px', border:'1px solid #334155', maxWidth:'200px' },
            }
          return `${object.hex}  count: ${object.count ?? '—'}`
        },
        layers: [makeBaseLayer(H3HexagonLayer, h3Data, optsRef.current)],
      })
      map.addControl(overlay)

      mapRef.current = { map, overlay, H3HexagonLayer, ScatterplotLayer, IconLayer, GeoJsonLayer }
      setReady(true)
    }

    init()
    return () => { map?.remove(); mapDiv?.remove(); mapRef.current = null }
  }, [finishDrawing])

  // ── Cursor / double-click-zoom when draw mode toggles ─────────────────
  useEffect(() => {
    const map = mapRef.current?.map
    if (!map) return
    map.getCanvas().style.cursor = drawMode ? 'crosshair' : ''
    drawMode ? map.doubleClickZoom.disable() : map.doubleClickZoom.enable()
  }, [drawMode, ready])

  // ── Keep selectedVertexIdx ref in sync ───────────────────────────────
  useEffect(() => { selectedVertexIdxRef.current = selectedVertexIdx }, [selectedVertexIdx])

  // ── Select vertex on click (after polygon is complete) ────────────────
  useEffect(() => {
    if (!isComplete || drawMode) return
    const map = mapRef.current?.map
    if (!map) return
    const handler = (e) => {
      const feats = map.queryRenderedFeatures(e.point, { layers: ['sel-vertices-circles'] })
      setSelectedVertexIdx(feats.length ? feats[0].properties.index : null)
    }
    map.on('click', handler)
    return () => { map.off('click', handler) }
  }, [isComplete, drawMode, ready])

  // ── Delete key → remove selected vertex ──────────────────────────────
  // Use capture:true so we catch the event before the map canvas can stop propagation
  useEffect(() => {
    if (!isComplete || drawMode) return
    const handler = (e) => {
      if (e.key !== 'Delete') return
      // Don't intercept Delete inside text inputs
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      deleteVertex()
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [isComplete, drawMode, deleteVertex])

  // ── Sync MapLibre polygon visuals ─────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current?.map
    if (!map || !map.isStyleLoaded()) return

    const pts = polygonPoints

    // Outline = vertices + rubber-band cursor + closing edge when complete
    const outlinePts = [
      ...pts,
      ...(drawMode && cursorPos ? [cursorPos] : []),
      ...(isComplete && pts.length >= 3 ? [pts[0]] : []),
    ]

    const fillData = isComplete && pts.length >= 3
      ? EMPTY_FEAT({ type: 'Polygon', coordinates: [[...pts, pts[0]]] })
      : EMPTY_FEAT({ type: 'Polygon', coordinates: [[]] })

    const outlineData = outlinePts.length >= 2
      ? EMPTY_FEAT({ type: 'LineString', coordinates: outlinePts })
      : EMPTY_FC

    // Each vertex carries its index so the drag handler can identify it
    const vertexFC = {
      type: 'FeatureCollection',
      features: pts.map(([lng, lat], i) =>
        EMPTY_FEAT({ type: 'Point', coordinates: [lng, lat] }, { index: i, selected: isComplete && !drawMode && i === selectedVertexIdx })
      ),
    }

    // Midpoints: one per edge, only when polygon is complete
    const midpointFC = isComplete && pts.length >= 2 ? {
      type: 'FeatureCollection',
      features: pts.map(([lng, lat], i) => {
        const [nlng, nlat] = pts[(i + 1) % pts.length]
        return EMPTY_FEAT(
          { type: 'Point', coordinates: [(lng + nlng) / 2, (lat + nlat) / 2] },
          { edgeIndex: i }
        )
      }),
    } : EMPTY_FC

    map.getSource('sel-polygon')  ?.setData(fillData)
    map.getSource('sel-outline')  ?.setData(outlineData)
    map.getSource('sel-vertices') ?.setData(vertexFC)
    map.getSource('sel-midpoints')?.setData(midpointFC)

    // Highlight selected vertex visually
    if (isComplete && !drawMode && selectedVertexIdx !== null) {
      map.setPaintProperty('sel-vertices-circles', 'circle-color', [
        'case',
        ['==', ['get', 'selected'], true], '#ef4444', // highlight selected vertex in red
        '#38bdf8' // normal color
      ])
      map.setPaintProperty('sel-vertices-circles', 'circle-radius', [
        'case',
        ['==', ['get', 'selected'], true], 11, // larger radius for selected
        7
      ])
    } else {
      map.setPaintProperty('sel-vertices-circles', 'circle-color', '#38bdf8')
      map.setPaintProperty('sel-vertices-circles', 'circle-radius', 7)
    }
  }, [polygonPoints, isComplete, cursorPos, drawMode, selectedVertexIdx, styleVersion, ready])

  // ── Sync search marker (lat/lng pin) ─────────────────────────────────
  useEffect(() => {
    const map = mapRef.current?.map
    const mgl = window.maplibregl
    if (!map || !mgl) return

    searchMarkerRef.current?.remove()
    searchMarkerRef.current = null

    if (searchResult?.type === 'latlng') {
      // Custom teardrop pin element
      const el = document.createElement('div')
      Object.assign(el.style, {
        width:'22px', height:'22px', borderRadius:'50% 50% 50% 0',
        background:'#ef4444', border:'2px solid #fff',
        transform:'rotate(-45deg)', boxShadow:'0 2px 8px rgba(0,0,0,0.35)',
        cursor:'default',
      })
      searchMarkerRef.current = new mgl.Marker({ element: el, anchor:'bottom' })
        .setLngLat([searchResult.lng, searchResult.lat])
        .addTo(map)
    }
  }, [searchResult, ready])

  // ── Sync search result polygon (H3 or pincode) ────────────────────────
  useEffect(() => {
    const map = mapRef.current?.map
    if (!map || !map.isStyleLoaded()) return
    const geojson = (searchResult?.type === 'h3' || searchResult?.type === 'pincode')
      ? searchResult.geojson
      : null
    map.getSource('search-result-source')?.setData(geojson ?? EMPTY_FC)
  }, [searchResult, styleVersion, ready])

  // ── Sync pincode boundary source ──────────────────────────────────────
  // Note: no isStyleLoaded() guard here — we always push the latest value.
  // The direct clearSelection() map call already handles the immediate wipe;
  // this effect is the authoritative sync for all other state transitions.
  useEffect(() => {
    const map = mapRef.current?.map
    if (!map) return
    const src = map.getSource('pincode-source')
    if (src) {
      src.setData(pincodeBoundaries ?? EMPTY_FC)
    } else if (map.isStyleLoaded()) {
      // Source not yet added (shouldn't happen after init, but guard anyway)
      map.getSource('pincode-source')?.setData(pincodeBoundaries ?? EMPTY_FC)
    }
  }, [pincodeBoundaries, styleVersion, ready])

  // ── Sync deck.gl layers ───────────────────────────────────────────────
  useEffect(() => {
    const r = mapRef.current
    if (!r) return
    const opts = { extruded, wireframe, coverage, elevationScale }

    // ── Points layer (bound) ──────────────────────────────────────────
    const filteredPoints = enabledCategories
      ? (pointsData ?? []).filter(d => enabledCategories.has(d.category))
      : (pointsData ?? [])
    const pointsBoundLayer = makePointLayer(r.IconLayer, {
      id: 'bound-points', visible: pointsVisible && filteredPoints.length > 0,
      data: filteredPoints, opacity: pointsOpacity, pointSize: pointsPinSize,
    })

    // ── Polygons layer (bound) ────────────────────────────────────────
    const filteredPolygons = enabledPolygonTypes
      ? (polygonsData ?? []).filter(d => enabledPolygonTypes.has(d.type))
      : (polygonsData ?? [])
    const processedPolygons = filteredPolygons.map(row => ({
      ...row,
      tooltip: [row.Circle, row.Pincode ? `📮 ${row.Pincode}` : null].filter(Boolean).join(' · '),
      colour: '#6366f1',
    }))
    const polygonsBoundLayer = makePolygonLayer(r.GeoJsonLayer, {
      id: 'bound-polygons', visible: polygonsVisible && processedPolygons.length > 0,
      data: processedPolygons, opacity: polygonsOpacity, strokeWidth: polygonsStrokeWidth,
    })

    r.overlay.setProps({
      layers: [
        makeBaseLayer(r.H3HexagonLayer, h3Data, opts),
        ...customLayers.map(layer => makeCustomLayer(r, layer)),
        makeCsvLayer(r.H3HexagonLayer, csvData, opts),
        polygonsBoundLayer,
        gridVisible && gridData?.length
          ? makeGridLayer(r.H3HexagonLayer, gridData, gridViz, gridOpacity, gridElevScale)
          : null,
        pointsBoundLayer,
        makeSelectionLayer(r.H3HexagonLayer, selectedCells, opts),
      ].filter(Boolean),
    })
  }, [extruded, wireframe, coverage, elevationScale, selectedCells, h3Data, csvData, customLayers,
      gridData, gridViz, gridOpacity, gridElevScale, gridVisible,
      pointsData, pointsVisible, pointsOpacity, pointsPinSize, enabledCategories,
      polygonsData, polygonsVisible, polygonsOpacity, polygonsStrokeWidth, enabledPolygonTypes])

  // ── UI ────────────────────────────────────────────────────────────────
  const hasPoints    = polygonPoints.length > 0
  const canFinish    = drawMode && polygonPoints.length >= 3
  const hasSelection = selectedCells.size > 0

  // Live-detect type while user types (no side effects)
  const liveDetected = searchQuery.trim() ? detectSearchType(searchQuery) : null
  const detectionLabel = liveDetected
    ? ({ latlng:'📍 Lat / Lng', h3:'⬡ H3 Index', pincode:'📮 Pincode', unknown:'❓ Unknown' }[liveDetected.type])
    : null

  return (
    <div style={{ position:'fixed', inset:0, pointerEvents:'none', zIndex:10 }}>

      {/* ── Global slider CSS ─────────────────────────────────────── */}
      <style>{`
        .geo-slider { -webkit-appearance:none; appearance:none; height:4px; border-radius:2px; outline:none; cursor:pointer; border:none; }
        .geo-slider::-webkit-slider-thumb { -webkit-appearance:none; width:14px; height:14px; border-radius:50%; background:#276ef1; cursor:pointer; border:2px solid #fff; box-shadow:0 1px 4px rgba(0,0,0,0.25); }
        .geo-slider::-moz-range-thumb { width:14px; height:14px; border-radius:50%; background:#276ef1; cursor:pointer; border:2px solid #fff; box-shadow:0 1px 4px rgba(0,0,0,0.25); }
      `}</style>

      {/* Hidden CSV file input — triggered by button click */}
      <input
        ref={csvInputRef}
        type="file"
        accept=".csv"
        style={{ display:'none' }}
        onChange={handleCsvUpload}
      />

      {/* ── Floating search bar — top-center ───────────────────────────── */}
      {ready && (
        <div className="gi-search-bar">
          {/* Input row */}
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink:0, color:'var(--gi-text-muted)' }}>
              <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
              <line x1="9.5" y1="9.5" x2="13" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <input
              type="text"
              placeholder="Search lat,lng · H3 index · pincode…"
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value); setSearchError(null) }}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              className="gi-search-input"
            />
            {searchStatus === 'loading'
              ? <LoadSpinner />
              : <button
                  onClick={handleSearch}
                  disabled={!searchQuery.trim()}
                  className="gi-btn gi-btn-primary"
                  style={{ padding:'0 14px', height:30, fontSize:12 }}
                >Search</button>
            }
            {(searchResult || searchError) && (
              <button onClick={clearSearch}
                className="gi-icon-btn"
                style={{ width:30, height:30, fontSize:14 }}>✕</button>
            )}
          </div>

          {/* Live detection badge */}
          {detectionLabel && !searchResult && (
            <div style={{ marginTop:7, fontSize:11, color:'var(--gi-text-muted)', display:'flex', alignItems:'center', gap:5 }}>
              <span style={{ width:6, height:6, borderRadius:'50%', background:'var(--gi-blue)', display:'inline-block', flexShrink:0 }}/>
              Detected: <strong style={{ color:'var(--gi-text-dim)' }}>{detectionLabel}</strong>
            </div>
          )}

          {/* Error */}
          {searchError && (
            <div className="gi-hint gi-hint-red" style={{ marginTop:7, marginBottom:0 }}>
              {searchError}
            </div>
          )}

          {/* Result summary */}
          {searchResult && (
            <div className="gi-hint gi-hint-blue" style={{ marginTop:7, marginBottom:0 }}>
              {searchResult.type === 'latlng' && (
                <><strong>{searchResult.lat.toFixed(6)}, {searchResult.lng.toFixed(6)}</strong> · Lat / Lng</>
              )}
              {searchResult.type === 'h3' && (
                <><strong>{searchResult.index}</strong> · H3 Res {searchResult.resolution}</>
              )}
              {searchResult.type === 'pincode' && (
                <>Pincode <strong>{searchResult.pincode}</strong>
                  {searchResult.geojson?.features[0]?.properties?.circle
                    ? <> · {searchResult.geojson.features[0].properties.circle}</>
                    : null}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Base layer switcher — bottom-left, collapsible ──────────────── */}
      {ready && (() => {
        const activeLayer = BASE_LAYERS.find(l => l.id === activeBaseLayer) ?? BASE_LAYERS[0]

        const Thumbnail = ({ layer, size = 52, active = false, onClick }) => (
          <div onClick={onClick} title={layer.label}
            style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:5, cursor:'pointer' }}>
            <div style={{
              width:size, height:size, borderRadius:9, overflow:'hidden', position:'relative',
              border: active ? '2.5px solid #388bfd' : '2px solid rgba(255,255,255,0.15)',
              boxShadow: active
                ? '0 0 0 1px #388bfd, 0 4px 12px rgba(0,0,0,0.5)'
                : '0 2px 8px rgba(0,0,0,0.5)',
              transition:'border-color 0.15s, box-shadow 0.15s',
            }}>
              <svg width={size} height={size} style={{ position:'absolute', inset:0, display:'block' }}>
                <rect width={size} height={size} fill={layer.bg} />
                <line x1="0"        y1={size*.38} x2={size} y2={size*.38} stroke={layer.roads} strokeWidth={size*.07} />
                <line x1="0"        y1={size*.65} x2={size} y2={size*.65} stroke={layer.roads} strokeWidth={size*.04} />
                <line x1={size*.35} y1="0"        x2={size*.35} y2={size} stroke={layer.roads} strokeWidth={size*.05} />
                <line x1={size*.7}  y1="0"        x2={size*.7}  y2={size} stroke={layer.roads} strokeWidth={size*.04} />
              </svg>
              {active && (
                <div style={{
                  position:'absolute', bottom:4, right:4,
                  width:16, height:16, borderRadius:'50%',
                  background:'#388bfd', border:'2px solid #0d1117',
                  display:'flex', alignItems:'center', justifyContent:'center',
                  fontSize:8, color:'#fff', fontWeight:800,
                }}>✓</div>
              )}
            </div>
            <span style={{
              fontSize:10, fontFamily:'system-ui,sans-serif',
              fontWeight: active ? 700 : 400,
              color: active ? '#e6edf3' : '#8b949e',
              textShadow:'0 1px 3px rgba(0,0,0,0.9)',
            }}>{layer.label}</span>
          </div>
        )

        return (
          <div ref={layerPickerRef} style={{ position:'absolute', bottom:32, left:12, pointerEvents:'auto' }}>
            {layerPickerOpen ? (
              <div style={{
                display:'flex', flexDirection:'column',
                background:'rgba(13,17,23,0.93)', backdropFilter:'blur(12px)',
                borderRadius:12, padding:'12px 14px',
                boxShadow:'0 8px 32px rgba(0,0,0,0.6)',
                border:'1px solid rgba(255,255,255,0.08)',
              }}>
                <div style={{
                  display:'flex', justifyContent:'space-between', alignItems:'center',
                  marginBottom:12,
                }}>
                  <span style={{ fontSize:11, fontWeight:600, color:'#8b949e', fontFamily:'system-ui,sans-serif', letterSpacing:'0.05em', textTransform:'uppercase' }}>
                    Map Style
                  </span>
                  <button onClick={() => setLayerPickerOpen(false)}
                    style={{ background:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.1)', borderRadius:5, cursor:'pointer', color:'#8b949e', fontSize:13, lineHeight:1, padding:'3px 6px', fontFamily:'inherit' }}>
                    ✕
                  </button>
                </div>
                <div style={{ display:'flex', gap:12 }}>
                  {BASE_LAYERS.map(layer => (
                    <Thumbnail key={layer.id} layer={layer}
                      active={activeBaseLayer === layer.id}
                      onClick={() => { handleBaseLayerChange(layer); setLayerPickerOpen(false) }}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4, cursor:'pointer' }}
                onClick={() => setLayerPickerOpen(true)}
                title="Change map style">
                <div style={{ position:'relative', width:52, height:52 }}>
                  <div style={{
                    position:'absolute', top:4, left:4, right:-4, bottom:-4,
                    borderRadius:9, background:activeLayer.bg, opacity:0.4,
                    border:'1.5px solid rgba(255,255,255,0.5)',
                    boxShadow:'0 2px 6px rgba(0,0,0,0.4)',
                  }} />
                  <div style={{
                    position:'absolute', top:2, left:2, right:-2, bottom:-2,
                    borderRadius:9, background:activeLayer.bg, opacity:0.65,
                    border:'1.5px solid rgba(255,255,255,0.6)',
                    boxShadow:'0 2px 6px rgba(0,0,0,0.4)',
                  }} />
                  <div style={{ position:'relative', zIndex:1 }}>
                    <Thumbnail layer={activeLayer} active size={52} />
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {/* ── Sidebar collapse tab (shown when panel is closed) ─────────── */}
      {ready && !panelOpen && (
        <button
          onClick={() => setPanelOpen(true)}
          title="Open panel"
          style={{
            position:'absolute', top:'50%', right:0, transform:'translateY(-50%)',
            pointerEvents:'auto',
            background:'var(--gi-surface)', border:'1px solid var(--gi-border-default)', borderRight:'none',
            borderRadius:'8px 0 0 8px', width:24, height:56, cursor:'pointer',
            display:'flex', alignItems:'center', justifyContent:'center',
            boxShadow:'-3px 0 12px rgba(0,0,0,0.4)', color:'var(--gi-text-dim)', fontSize:14,
          }}>‹</button>
      )}

      {ready && panelOpen && (
        <div className="gi-sidebar">

          {/* ── Panel header ──────────────────────────────────────────────── */}
          <div className="gi-sidebar-header">
            <div className="gi-sidebar-logo">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 1L14.928 5V11L8 15L1.072 11V5L8 1Z" stroke="rgba(255,255,255,0.9)" strokeWidth="1.3" fill="rgba(255,255,255,0.1)"/>
                <path d="M8 5L11.464 7V11L8 13L4.536 11V7L8 5Z" fill="rgba(255,255,255,0.6)"/>
              </svg>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:13, fontWeight:700, color:'var(--gi-text)', letterSpacing:'0.02em' }}>GeoIntel</div>
              <div style={{ fontSize:9, color:'var(--gi-text-muted)', letterSpacing:'0.06em', textTransform:'uppercase', marginTop:1 }}>Geospatial Analytics</div>
            </div>
            <button
              onClick={() => setPanelOpen(false)}
              title="Collapse panel"
              className="gi-icon-btn"
              style={{ width:28, height:28, fontSize:14 }}>›</button>
          </div>

          {/* ── Scrollable content ────────────────────────────────────────── */}
          <div className="gi-sidebar-content gi-scroll">

            {/* ── Bound Area ──────────────────────────────────────────────── */}
            <div style={{ padding:'12px 14px', borderBottom:'1px solid var(--gi-border)' }}>

              {/* Section label */}
              <div style={{ display:'flex', alignItems:'center', gap:7, marginBottom:10 }}>
                <div className="gi-section-icon" style={{ background:'rgba(56,139,253,0.15)' }}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <rect x="1" y="1" width="10" height="10" rx="2" stroke="#388bfd" strokeWidth="1.3"/>
                    <path d="M4 6h4M6 4v4" stroke="#388bfd" strokeWidth="1.3" strokeLinecap="round"/>
                  </svg>
                </div>
                <span className="gi-section-title">Bound Area</span>
                {boundMeta && (
                  <span className="gi-badge" style={{
                    background: boundMeta.type === 'all' ? 'rgba(210,153,34,0.15)' : 'rgba(63,185,80,0.15)',
                    color: boundMeta.type === 'all' ? 'var(--gi-yellow)' : 'var(--gi-green)',
                    border: `1px solid ${boundMeta.type === 'all' ? 'rgba(210,153,34,0.3)' : 'rgba(63,185,80,0.3)'}`,
                  }}>
                    {boundMeta.type === 'all' ? 'All' : 'Active'}
                  </span>
                )}
              </div>

              {/* Mode tabs */}
              <div className="gi-tabs" style={{ marginBottom:10 }}>
                {[
                  { key:'draw',    label:'Draw'    },
                  { key:'pincode', label:'Pincode' },
                  { key:'circle',  label:'Circle'  },
                  { key:'custom',  label:'Custom'  },
                  { key:'sql',     label:'SQL'     },
                ].map(({ key, label }) => (
                  <button key={key} onClick={() => setBoundMode(key)}
                    className={`gi-tab${boundMode === key ? ' active' : ''}`}>
                    {label}
                  </button>
                ))}
              </div>

              {/* Load all button */}
              <button
                onClick={loadAllData}
                disabled={gridLoading || pointsLoading || polygonsLoading}
                className={`gi-btn ${boundMeta?.type === 'all' ? 'gi-btn-yellow' : 'gi-btn-ghost'}`}
                style={{ width:'100%', padding:'7px 0', marginBottom:8 }}>
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><circle cx="5.5" cy="5.5" r="4.5" stroke="currentColor" strokeWidth="1.2"/><path d="M5.5 2v3.5l2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                Load without spatial filter
              </button>

              {/* Active bound status */}
              {(boundGeoJSON || boundMeta) && (
                <div className="gi-hint" style={{
                  marginBottom:8,
                  background: boundMeta?.type === 'all' ? 'var(--gi-yellow-subtle)' : 'var(--gi-green-subtle)',
                  color: boundMeta?.type === 'all' ? 'var(--gi-yellow)' : 'var(--gi-green)',
                  borderColor: boundMeta?.type === 'all' ? 'rgba(210,153,34,0.3)' : 'rgba(63,185,80,0.3)',
                  display:'flex', alignItems:'center', gap:7,
                }}>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ flexShrink:0 }}>
                    <circle cx="5" cy="5" r="4" fill="currentColor" opacity="0.25"/>
                    <path d="M3 5l1.5 1.5L7 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <span style={{ fontWeight:600 }}>
                    {boundMeta?.type === 'all'      ? 'All data loaded — no filter'
                    : boundMeta?.type === 'pincodes' ? `Pincode${boundMeta.values?.length > 1 ? 's' : ''}: ${boundMeta.values?.join(', ')}`
                    : boundMeta?.type === 'circles'  ? `Circle${boundMeta.values?.length > 1 ? 's' : ''}: ${boundMeta.values?.join(', ')}`
                    : boundMeta?.type === 'sql'      ? 'SQL bound active'
                    : 'Custom polygon active'}
                  </span>
                </div>
              )}

              {/* ── Draw mode ── */}
              {boundMode === 'draw' && (
                <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
                  {!isComplete && !drawMode && (
                    <button className="gi-btn gi-btn-primary" onClick={() => { clearSelection(); setDrawMode(true) }}
                      style={{ width:'100%', padding:'8px 0' }}>
                      <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1 10L3.5 4.5L8.5 2L6 7.5L1 10Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
                      Start Drawing
                    </button>
                  )}
                  {drawMode && (
                    <>
                      <Hint blue>Click to place vertices · Double-click or Finish to close polygon</Hint>
                      <div style={{ display:'flex', gap:6 }}>
                        {polygonPoints.length >= 3 && (
                          <button className="gi-btn gi-btn-primary" onClick={finishDrawing}
                            style={{ flex:1, padding:'7px 0' }}>
                            ✓ Finish ({polygonPoints.length}pts)
                          </button>
                        )}
                        <button className="gi-btn gi-btn-ghost" onClick={clearSelection}
                          style={{ flex:1, padding:'7px 0' }}>
                          Cancel
                        </button>
                      </div>
                    </>
                  )}
                  {isComplete && !drawMode && (
                    <button className="gi-btn gi-btn-subtle" onClick={() => { clearSelection(); setTimeout(() => setDrawMode(true), 50) }}
                      style={{ width:'100%', padding:'7px 0' }}>
                      ↺ Redraw
                    </button>
                  )}
                </div>
              )}

              {/* ── Pincode mode ── */}
              {boundMode === 'pincode' && (
                <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
                  <div style={{ display:'flex', gap:6 }}>
                    <input type="text" placeholder="e.g. 411001, 411002"
                      value={pincodeInput} onChange={e => setPincodeInput(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && applyPincodeBound()}
                      className="gi-input" style={{ flex:1, height:32, padding:'0 9px' }} />
                    <button onClick={applyPincodeBound}
                      disabled={boundLoading || !pincodeInput.trim()}
                      className="gi-btn gi-btn-primary"
                      style={{ padding:'0 14px', height:32, flexShrink:0 }}>
                      {boundLoading ? <LoadSpinner /> : 'Apply'}
                    </button>
                  </div>
                  {boundError && <Hint red>{boundError}</Hint>}
                </div>
              )}

              {/* ── Circle mode ── */}
              {boundMode === 'circle' && (
                <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
                  <div style={{ display:'flex', gap:6 }}>
                    <input type="text" placeholder="e.g. Pune or Pune, Mumbai"
                      value={circleInput} onChange={e => setCircleInput(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && applyCircleBound()}
                      className="gi-input" style={{ flex:1, height:32, padding:'0 9px' }} />
                    <button onClick={applyCircleBound}
                      disabled={boundLoading || !circleInput.trim()}
                      className="gi-btn gi-btn-primary"
                      style={{ padding:'0 14px', height:32, flexShrink:0, background:'#7c3aed', borderColor:'#7c3aed' }}>
                      {boundLoading ? <LoadSpinner /> : 'Apply'}
                    </button>
                  </div>
                  {boundError && <Hint red>{boundError}</Hint>}
                </div>
              )}

              {/* ── Custom GeoJSON mode ── */}
              {boundMode === 'custom' && (
                <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
                  <textarea
                    placeholder={'Paste GeoJSON Polygon or [[lng,lat],…] array\n\n{"type":"Polygon","coordinates":[…]}'}
                    value={customPolygonText}
                    onChange={e => { setCustomPolygonText(e.target.value); setCustomPolygonError(null) }}
                    className="gi-input"
                    style={{ minHeight:88, fontSize:11, fontFamily:'monospace', padding:'7px 9px' }}
                  />
                  {customPolygonError && <Hint red>{customPolygonError}</Hint>}
                  <button onClick={applyCustomPolygon} disabled={!customPolygonText.trim()}
                    className="gi-btn gi-btn-primary" style={{ width:'100%', padding:'7px 0' }}>
                    Apply Polygon
                  </button>
                </div>
              )}

              {/* ── SQL bound mode ── */}
              {boundMode === 'sql' && (
                <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
                  <div className="gi-hint gi-hint-neutral" style={{ marginBottom:0 }}>
                    Write SQL returning a <code style={{ background:'var(--gi-card)', color:'var(--gi-cyan)', padding:'1px 4px', borderRadius:3, fontSize:11 }}>geometry</code> column — unioned result becomes the active bound.
                  </div>
                  <textarea
                    placeholder={"SELECT geometry FROM polygons\nWHERE \"Circle\" = 'Pune'"}
                    value={sqlBoundQuery}
                    onChange={e => { setSqlBoundQuery(e.target.value); setSqlBoundError(null) }}
                    onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) applySQLBound() }}
                    className="gi-input"
                    style={{
                      minHeight:96, fontSize:11, fontFamily:'monospace', padding:'7px 9px',
                      borderColor: sqlBoundError ? 'rgba(248,81,73,0.5)' : undefined,
                    }}
                  />
                  {sqlBoundError && <Hint red>{sqlBoundError}</Hint>}
                  <button
                    onClick={applySQLBound}
                    disabled={boundLoading || !sqlBoundQuery.trim()}
                    className="gi-btn gi-btn-primary"
                    style={{ width:'100%', padding:'7px 0' }}>
                    {boundLoading ? <><LoadSpinner /> Running…</> : '▶ Run & Apply Bound'}
                  </button>
                  <div style={{ fontSize:10, color:'var(--gi-text-muted)', textAlign:'center' }}>Ctrl+Enter to run</div>
                </div>
              )}

              {/* ── Clear Bound ── */}
              {(boundGeoJSON || boundMeta) && (
                <button onClick={clearSelection}
                  className="gi-btn gi-btn-danger"
                  style={{ width:'100%', padding:'7px 0', marginTop:8 }}>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                  Clear Bound
                </button>
              )}
            </div>

            {/* ══════════════════════════════════════════════════════
                 ⬡  H3 GRIDS
            ══════════════════════════════════════════════════════ */}
            <div className="gi-section-hd" onClick={() => setGridOpen(v => !v)} style={{ cursor:'pointer' }}>
              <div className="gi-section-icon" style={{ background:'rgba(99,102,241,0.15)' }}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M6 1L10.33 3.5V8.5L6 11L1.67 8.5V3.5L6 1Z" stroke="#a371f7" strokeWidth="1.2"/>
                </svg>
              </div>
              <span className="gi-section-title">H3 Grids</span>
              {gridLoading && <LoadSpinner />}
              {gridData && !gridLoading && (
                <span className="gi-badge gi-badge-blue">{gridData.length.toLocaleString()}</span>
              )}
              {gridData && !gridLoading && (
                <button onClick={e => { e.stopPropagation(); setGridVisible(v => !v) }}
                  className={`gi-icon-btn${gridVisible ? ' active' : ''}`}
                  style={{ width:26, height:26 }} title={gridVisible ? 'Hide' : 'Show'}>
                  <EyeIcon open={gridVisible} />
                </button>
              )}
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ marginLeft:'auto', flexShrink:0, transition:'transform 0.2s', transform: gridOpen ? 'rotate(180deg)' : 'rotate(0deg)', color:'var(--gi-text-muted)' }}>
                <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>

            {gridOpen && (
            <div className="gi-section-body">
              {gridError && <Hint red>{gridError}</Hint>}
              {dataStale && gridData && (
                <button onClick={handleRefetchAll}
                  className="gi-btn gi-btn-yellow"
                  style={{ width:'100%', padding:'7px 0', marginBottom:8 }}>
                  ↻ Polygon changed — Re-fetch data
                </button>
              )}
              {!gridData && !gridLoading && (
                <div style={{ display:'flex', flexDirection:'column', gap:8, alignItems:'center' }}>
                  {!boundGeoJSON && boundMeta?.type !== 'all' ? (
                    <div className="gi-empty">Set a bound above, then load.</div>
                  ) : (
                    <>
                      <div className="gi-empty" style={{ marginBottom:0 }}>H3 grid data not loaded yet.</div>
                      <button onClick={() => fetchGridData()}
                        className="gi-btn gi-btn-primary"
                        style={{ width:'100%', padding:'8px 0' }}>
                        ⬡ Load H3 Grids
                      </button>
                    </>
                  )}
                </div>
              )}
              {gridData && !gridLoading && (
                <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                  <MiniRange label="Opacity" min={0} max={1} step={0.01} value={gridOpacity}
                    fmt={v => `${Math.round(v*100)}%`} onChange={setGridOpacity} />

                  <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                    {[
                      { key:'population', label:'Population', color:'#f59e0b', icon: <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><circle cx="4" cy="3.5" r="2" stroke="currentColor" strokeWidth="1.2"/><circle cx="8" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.2"/><path d="M1 10c0-2 1.3-3 3-3s3 1 3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg> },
                      { key:'land_cover', label:'Land Cover', color:'#3fb950', icon: <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M5.5 1v4M3 3l2.5 2 2.5-2M1.5 8.5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg> },
                      { key:'base',       label:'Base Grid',  color:'#a371f7', icon: <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M5.5 1L9 3.25V7.75L5.5 10L2 7.75V3.25L5.5 1Z" stroke="currentColor" strokeWidth="1.2"/></svg> },
                    ].map(({ key, label, color, icon }) => {
                      const active = gridViz === key
                      return (
                        <button key={key} onClick={() => setGridViz(key)}
                          className={`gi-viz-btn${active ? ' active' : ''}`}
                          style={active ? { background:color, borderColor:color } : {}}>
                          <span style={{ color: active ? 'rgba(255,255,255,0.9)' : color, lineHeight:0 }}>{icon}</span>
                          <span style={{ flex:1 }}>{label}</span>
                          {active && <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M2 4l1.5 1.5L6 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>}
                        </button>
                      )
                    })}
                  </div>

                  {gridViz === 'population' && (
                    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                      <MiniRange label="Elev Scale" min={0.1} max={50} step={0.1} value={gridElevScale}
                        fmt={v => `${v.toFixed(1)}×`} onChange={setGridElevScale} />
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        <span style={{ fontSize:10, color:'var(--gi-text-muted)', flexShrink:0 }}>Low</span>
                        <div style={{ flex:1, height:5, borderRadius:3, background:'linear-gradient(to right, #ffff32, #ff8800, #ff3200)' }}/>
                        <span style={{ fontSize:10, color:'var(--gi-text-muted)', flexShrink:0 }}>High</span>
                      </div>
                    </div>
                  )}

                  {gridViz === 'land_cover' && (() => {
                    const present = new Set(gridData.map(d => Number(d.dominant_class)).filter(Boolean))
                    const entries = Object.entries(LAND_COVER_LABELS).filter(([k]) => present.has(Number(k)))
                    return (
                      <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                        {entries.map(([k, label]) => {
                          const [rv,g,b] = LAND_COVER_COLORS[Number(k)] ?? [128,128,128]
                          return (
                            <div key={k} style={{ display:'flex', alignItems:'center', gap:8, padding:'3px 2px' }}>
                              <div style={{ width:9, height:9, borderRadius:2, flexShrink:0, background:`rgb(${rv},${g},${b})` }}/>
                              <span style={{ fontSize:11, color:'var(--gi-text-dim)' }}>{label}</span>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })()}
                </div>
              )}
            </div>
            )}

            {/* ══════════════════════════════════════════════════════
                 📍  POINTS
            ══════════════════════════════════════════════════════ */}
            <div className="gi-section-hd" onClick={() => setPointsOpen(v => !v)} style={{ cursor:'pointer' }}>
              <div className="gi-section-icon" style={{ background:'rgba(248,81,73,0.12)' }}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M6 1C4.067 1 2.5 2.567 2.5 4.5 2.5 7.5 6 11 6 11s3.5-3.5 3.5-6.5C9.5 2.567 7.933 1 6 1z" stroke="#f85149" strokeWidth="1.2"/>
                  <circle cx="6" cy="4.5" r="1.2" fill="#f85149"/>
                </svg>
              </div>
              <span className="gi-section-title">Points</span>
              {pointsLoading && <LoadSpinner />}
              {pointsData && !pointsLoading && (
                <span className="gi-badge gi-badge-blue">{pointsData.length.toLocaleString()}</span>
              )}
              {pointsData && !pointsLoading && (
                <button onClick={e => { e.stopPropagation(); setPointsVisible(v => !v) }}
                  className={`gi-icon-btn${pointsVisible ? ' active' : ''}`}
                  style={{ width:26, height:26 }} title={pointsVisible ? 'Hide' : 'Show'}>
                  <EyeIcon open={pointsVisible} />
                </button>
              )}
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ marginLeft:'auto', flexShrink:0, transition:'transform 0.2s', transform: pointsOpen ? 'rotate(180deg)' : 'rotate(0deg)', color:'var(--gi-text-muted)' }}>
                <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>

            {pointsOpen && (
            <div className="gi-section-body">
              {pointsError && <Hint red>{pointsError}</Hint>}
              {!pointsData && !pointsLoading && (
                <div style={{ display:'flex', flexDirection:'column', gap:8, alignItems:'center' }}>
                  {!boundGeoJSON && boundMeta?.type !== 'all' ? (
                    <div className="gi-empty">Set a bound above, then load.</div>
                  ) : (
                    <>
                      <div className="gi-empty" style={{ marginBottom:0 }}>Points data not loaded yet.</div>
                      <button onClick={() => fetchPointsData()}
                        className="gi-btn gi-btn-primary"
                        style={{ width:'100%', padding:'8px 0' }}>
                        📍 Load Points
                      </button>
                    </>
                  )}
                </div>
              )}
              {pointsData && !pointsLoading && (
                <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                  <MiniRange label="Opacity"  min={0}  max={1}  step={0.01} value={pointsOpacity} fmt={v => `${Math.round(v*100)}%`} onChange={setPointsOpacity} />
                  <MiniRange label="Pin Size" min={16} max={60} step={1}    value={pointsPinSize} fmt={v => `${v}px`}                onChange={setPointsPinSize} />

                  {(() => {
                    const cats = [...new Set(pointsData.map(d => d.category ?? 'Unknown'))]
                    if (!cats.length) return null
                    return (
                      <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
                        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:4 }}>
                          <span style={{ fontSize:11, fontWeight:600, color:'var(--gi-text-dim)', letterSpacing:'0.03em' }}>Categories</span>
                          <button onClick={() => setEnabledCategories(null)}
                            style={{ background:'none', border:'none', cursor:'pointer', fontSize:10, color:'var(--gi-blue)', padding:0, fontFamily:'inherit' }}>
                            Select All
                          </button>
                        </div>
                        {cats.map(cat => {
                          const color   = PIN_COLORS[cat] ?? PIN_COLORS.default
                          const checked = !enabledCategories || enabledCategories.has(cat)
                          return (
                            <label key={cat} className="gi-filter-row">
                              <input type="checkbox" checked={checked}
                                onChange={e => {
                                  setEnabledCategories(prev => {
                                    const base = prev ?? new Set(cats)
                                    const next = new Set(base)
                                    e.target.checked ? next.add(cat) : next.delete(cat)
                                    return next.size === cats.length ? null : next
                                  })
                                }}
                                style={{ accentColor: color, width:13, height:13, cursor:'pointer', flexShrink:0 }} />
                              <div style={{ width:8, height:8, borderRadius:'50%', background:color, flexShrink:0 }}/>
                              <span style={{ fontSize:11, color:'var(--gi-text)', flex:1 }}>{cat}</span>
                              <span style={{ fontSize:10, color:'var(--gi-text-muted)' }}>
                                {pointsData.filter(d => (d.category ?? 'Unknown') === cat).length}
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    )
                  })()}
                </div>
              )}
            </div>
            )}

            {/* ══════════════════════════════════════════════════════
                 🗺  POLYGONS
            ══════════════════════════════════════════════════════ */}
            <div className="gi-section-hd" onClick={() => setPolygonsOpen(v => !v)} style={{ cursor:'pointer' }}>
              <div className="gi-section-icon" style={{ background:'rgba(163,113,247,0.12)' }}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2 9L1 3l4-2 5 3-2 5L2 9z" stroke="#a371f7" strokeWidth="1.2" strokeLinejoin="round"/>
                </svg>
              </div>
              <span className="gi-section-title">Polygons</span>
              {polygonsLoading && <LoadSpinner />}
              {polygonsData && !polygonsLoading && (
                <span className="gi-badge gi-badge-blue">{polygonsData.length.toLocaleString()}</span>
              )}
              {polygonsData && !polygonsLoading && (
                <button onClick={e => { e.stopPropagation(); setPolygonsVisible(v => !v) }}
                  className={`gi-icon-btn${polygonsVisible ? ' active' : ''}`}
                  style={{ width:26, height:26 }} title={polygonsVisible ? 'Hide' : 'Show'}>
                  <EyeIcon open={polygonsVisible} />
                </button>
              )}
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ marginLeft:'auto', flexShrink:0, transition:'transform 0.2s', transform: polygonsOpen ? 'rotate(180deg)' : 'rotate(0deg)', color:'var(--gi-text-muted)' }}>
                <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>

            {polygonsOpen && (
            <div className="gi-section-body">
              {polygonsError && <Hint red>{polygonsError}</Hint>}
              {!polygonsData && !polygonsLoading && (
                <div style={{ display:'flex', flexDirection:'column', gap:8, alignItems:'center' }}>
                  {!boundGeoJSON && boundMeta?.type !== 'all' ? (
                    <div className="gi-empty">Set a bound above, then load.</div>
                  ) : (
                    <>
                      <div className="gi-empty" style={{ marginBottom:0 }}>Polygon data not loaded yet.</div>
                      <button onClick={() => fetchPolygonsData()}
                        className="gi-btn gi-btn-primary"
                        style={{ width:'100%', padding:'8px 0' }}>
                        🗺 Load Polygons
                      </button>
                    </>
                  )}
                </div>
              )}
              {polygonsData && !polygonsLoading && (
                <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                  <MiniRange label="Opacity" min={0}   max={1}  step={0.01} value={polygonsOpacity}     fmt={v => `${Math.round(v*100)}%`} onChange={setPolygonsOpacity} />
                  <MiniRange label="Stroke"  min={0.5} max={8}  step={0.5}  value={polygonsStrokeWidth} fmt={v => `${v}px`}                onChange={setPolygonsStrokeWidth} />

                  {(() => {
                    const types = [...new Set(polygonsData.map(d => d.type ?? 'unknown'))]
                    if (!types.length) return null
                    return (
                      <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
                        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:4 }}>
                          <span style={{ fontSize:11, fontWeight:600, color:'var(--gi-text-dim)', letterSpacing:'0.03em' }}>Types</span>
                          <button onClick={() => setEnabledPolygonTypes(null)}
                            style={{ background:'none', border:'none', cursor:'pointer', fontSize:10, color:'var(--gi-blue)', padding:0, fontFamily:'inherit' }}>
                            Select All
                          </button>
                        </div>
                        {types.map(type => {
                          const checked = !enabledPolygonTypes || enabledPolygonTypes.has(type)
                          return (
                            <label key={type} className="gi-filter-row">
                              <input type="checkbox" checked={checked}
                                onChange={e => {
                                  setEnabledPolygonTypes(prev => {
                                    const base = prev ?? new Set(types)
                                    const next = new Set(base)
                                    e.target.checked ? next.add(type) : next.delete(type)
                                    return next.size === types.length ? null : next
                                  })
                                }}
                                style={{ accentColor:'var(--gi-purple)', width:13, height:13, cursor:'pointer', flexShrink:0 }} />
                              <div style={{ width:8, height:8, borderRadius:2, background:'var(--gi-purple)', flexShrink:0 }}/>
                              <span style={{ fontSize:11, color:'var(--gi-text)', flex:1 }}>{type}</span>
                              <span style={{ fontSize:10, color:'var(--gi-text-muted)' }}>
                                {polygonsData.filter(d => (d.type ?? 'unknown') === type).length}
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    )
                  })()}
                </div>
              )}
            </div>
            )}

            {/* ══════════════════════════════════════════════════════
                 ⚙  SQL LAYERS
            ══════════════════════════════════════════════════════ */}
            <div className="gi-section-hd" onClick={() => setSqlOpen(v => !v)} style={{ cursor:'pointer', borderTop:'1px solid var(--gi-border)' }}>
              <div className="gi-section-icon" style={{ background:'rgba(56,139,253,0.12)' }}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <rect x="1" y="1" width="10" height="3" rx="1" stroke="#388bfd" strokeWidth="1.2"/>
                  <rect x="1" y="5" width="10" height="3" rx="1" stroke="#388bfd" strokeWidth="1.2"/>
                  <rect x="1" y="9" width="4" height="2" rx="1" stroke="#388bfd" strokeWidth="1.2"/>
                </svg>
              </div>
              <span className="gi-section-title">SQL Layers</span>
              {customLayers.length > 0 && (
                <span className="gi-badge gi-badge-neutral">{customLayers.length}</span>
              )}
              <button onClick={e => { e.stopPropagation(); openAddModal() }}
                className="gi-btn gi-btn-primary"
                style={{ padding:'4px 10px', fontSize:11 }}>
                + Add
              </button>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ flexShrink:0, transition:'transform 0.2s', transform: sqlOpen ? 'rotate(180deg)' : 'rotate(0deg)', color:'var(--gi-text-muted)' }}>
                <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>

            {sqlOpen && (
            <div className="gi-section-body" style={{ paddingBottom:16 }}>
              {customLayers.length === 0 && (
                <div className="gi-empty">
                  No SQL layers yet.<br/>
                  <span style={{ color:'var(--gi-blue)' }}>Click + Add to create one.</span>
                </div>
              )}

              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                {customLayers.map(layer => (
                  <div key={layer.id}
                    draggable
                    onDragStart={e => {
                      if (!dragFromHandleRef.current) { e.preventDefault(); return }
                      dragFromHandleRef.current = false
                      handleLayerDragStart(e, layer.id)
                    }}
                    onDragEnd={() => { dragFromHandleRef.current = false }}
                    onDragOver={handleLayerDragOver}
                    onDrop={e => handleLayerDrop(e, layer.id)}
                    className={`gi-layer-card${!layer.visible ? ' dim' : ''}`}>

                    {/* ── Layer Header ── */}
                    <div className="gi-layer-hd">
                      <span
                        className="gi-drag-handle"
                        onMouseDown={() => { dragFromHandleRef.current = true }}
                        onMouseUp={()   => { dragFromHandleRef.current = false }}
                        title="Drag to reorder">
                        <DragIcon />
                      </span>
                      <button
                        onClick={() => updateLayer(layer.id, { visible: !layer.visible })}
                        title={layer.visible ? 'Hide layer' : 'Show layer'}
                        className={`gi-icon-btn${layer.visible ? ' active' : ''}`}
                        style={{ width:22, height:22, border:'none', background:'none' }}>
                        <EyeIcon open={layer.visible} />
                      </button>
                      <span style={{ flex:1, fontSize:12, fontWeight:600,
                        color: layer.visible ? 'var(--gi-text)' : 'var(--gi-text-muted)',
                        overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}
                        title={layer.name}>
                        {layer.name}
                      </span>
                      {layer.loading && <LoadSpinner />}
                      {!layer.loading && layer.data && (
                        <span className="gi-badge gi-badge-neutral" style={{ marginRight:4 }}>
                          {layer.data.length.toLocaleString()}
                        </span>
                      )}
                      {layer.error && (
                        <span style={{ fontSize:12, color:'var(--gi-red)', flexShrink:0, marginRight:4 }} title={layer.error}>⚠</span>
                      )}
                      <button
                        onClick={() => updateLayer(layer.id, { expanded: !layer.expanded })}
                        className="gi-icon-btn"
                        style={{ width:22, height:22, border:'none', background:'none' }}>
                        <ChevronIcon up={layer.expanded} />
                      </button>
                    </div>

                    {/* ── Expanded Body ── */}
                    {layer.expanded && (
                      <div className="gi-layer-body">
                        <pre style={{ margin:0, fontSize:10.5,
                          fontFamily:'"Fira Code","Cascadia Code","JetBrains Mono",monospace',
                          color:'#f8f8f2', background:'#1a1f2e', borderRadius:6,
                          padding:'8px 10px', whiteSpace:'pre-wrap', wordBreak:'break-all',
                          maxHeight:58, overflowY:'auto', lineHeight:1.5,
                          border:'1px solid var(--gi-border-default)' }}>
                          {layer.query}
                        </pre>
                        {layer.error && <Hint red>{layer.error}</Hint>}
                        <MiniRange label="Opacity" min={0} max={1} step={0.01} value={layer.opacity}
                          fmt={v => `${Math.round(v*100)}%`}
                          onChange={v => updateLayer(layer.id, { opacity: v })} />
                        {layer.layerType === 'point' ? (
                          <MiniRange label="Pin Size" min={16} max={60} step={1} value={layer.pointSize ?? 36}
                            fmt={v => `${v}px`} onChange={v => updateLayer(layer.id, { pointSize: v })} />
                        ) : layer.layerType === 'scatter' ? (
                          <MiniRange label="Radius" min={0.1} max={50} step={0.1} value={layer.radiusScale ?? 1}
                            fmt={v => `${v.toFixed(1)}×`} onChange={v => updateLayer(layer.id, { radiusScale: v })} />
                        ) : layer.layerType === 'polygon' ? (
                          <MiniRange label="Stroke" min={1} max={12} step={0.5} value={layer.strokeWidth ?? 2}
                            fmt={v => `${v}px`} onChange={v => updateLayer(layer.id, { strokeWidth: v })} />
                        ) : (
                          <>
                            <MiniRange label="Coverage" min={0} max={1} step={0.01} value={layer.coverage}
                              fmt={v => v.toFixed(2)} onChange={v => updateLayer(layer.id, { coverage: v })} />
                            <MiniRange label="Elev Scale" min={0} max={100} step={0.5} value={layer.elevationScale}
                              fmt={v => v.toFixed(1)} onChange={v => updateLayer(layer.id, { elevationScale: v })} />
                          </>
                        )}
                        {layer.layerType === 'point' && layer.data?.length > 0 && (() => {
                          const cats = [...new Set(layer.data.map(d => d.category ?? 'Unknown'))]
                          return (
                            <div style={{ display:'flex', flexWrap:'wrap', gap:'4px 8px' }}>
                              {cats.map(cat => {
                                const color = PIN_COLORS[cat] ?? PIN_COLORS.default
                                return (
                                  <div key={cat} style={{ display:'flex', alignItems:'center', gap:5 }}>
                                    <div style={{ width:7, height:7, borderRadius:'50%', flexShrink:0, background: color }}/>
                                    <span style={{ fontSize:10, color:'var(--gi-text-muted)', whiteSpace:'nowrap' }}>{cat}</span>
                                  </div>
                                )
                              })}
                            </div>
                          )
                        })()}
                        {/* Clip to bound toggle */}
                        <label className={`gi-clip-toggle${layer.boundFilter ? ' active' : ''}`}>
                          <input
                            type="checkbox"
                            checked={layer.boundFilter ?? false}
                            onChange={e => {
                              const on = e.target.checked
                              updateLayer(layer.id, { boundFilter: on })
                              const clipNow = on && (boundMeta || boundGeoJSON)
                                ? { boundMeta, boundPolygon: boundGeoJSON }
                                : null
                              setTimeout(() => refreshLayer(layer.id, clipNow), 0)
                            }}
                            style={{ accentColor:'var(--gi-blue)', width:13, height:13, cursor:'pointer', flexShrink:0 }}
                          />
                          <span style={{ fontSize:11, color: layer.boundFilter ? 'var(--gi-blue)' : 'var(--gi-text-dim)', fontWeight: layer.boundFilter ? 600 : 400, flex:1 }}>
                            Clip to active bound
                          </span>
                          {!(boundMeta || boundGeoJSON) && (
                            <span style={{ fontSize:10, color:'var(--gi-text-muted)' }}>no bound</span>
                          )}
                        </label>
                        {/* Actions */}
                        <div style={{ display:'flex', gap:5 }}>
                          <button onClick={() => openEditModal(layer)}
                            className="gi-btn gi-btn-ghost" style={{ flex:1, padding:'6px 0', fontSize:11 }}>
                            Edit Query
                          </button>
                          <button onClick={() => refreshLayer(layer.id)} disabled={layer.loading}
                            className="gi-btn gi-btn-ghost" style={{ flex:1, padding:'6px 0', fontSize:11 }}>
                            Refresh
                          </button>
                          <button onClick={() => deleteLayer(layer.id)}
                            className="gi-btn gi-btn-danger" style={{ flex:1, padding:'6px 0', fontSize:11 }}>
                            Remove
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            )}

          </div>
        </div>
      )}

      {/* ── Add / Edit Layer Modal ──────────────────────────────────────── */}
      {showAddModal && (
        <div
          className="gi-modal-backdrop"
          onClick={e => { if (e.target === e.currentTarget) setShowAddModal(false) }}>
          <div className="gi-modal">

            {/* Header */}
            <div className="gi-modal-header">
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <div style={{ width:30, height:30, borderRadius:8, background:'var(--gi-blue-subtle)', border:'1px solid var(--gi-blue-muted)', display:'flex', alignItems:'center', justifyContent:'center' }}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <rect x="1" y="1" width="12" height="4" rx="1.5" stroke="var(--gi-blue)" strokeWidth="1.2"/>
                    <rect x="1" y="7" width="12" height="4" rx="1.5" stroke="var(--gi-blue)" strokeWidth="1.2"/>
                    <circle cx="3.5" cy="3" r="1" fill="var(--gi-blue)"/>
                    <circle cx="3.5" cy="9" r="1" fill="var(--gi-blue)"/>
                  </svg>
                </div>
                <div>
                  <span style={{ fontWeight:700, fontSize:14, color:'var(--gi-text)' }}>
                    {editingLayerId ? 'Edit SQL Layer' : 'Add SQL Layer'}
                  </span>
                  <div style={{ fontSize:10, color:'var(--gi-text-muted)', marginTop:1 }}>
                    Query results are automatically visualized as hex, pins, scatter, or polygons
                  </div>
                </div>
              </div>
              <button onClick={() => setShowAddModal(false)}
                className="gi-icon-btn" style={{ width:30, height:30, fontSize:15 }}>✕</button>
            </div>

            <div className="gi-modal-body gi-scroll">
              {/* Layer Name */}
              <div>
                <label className="gi-form-label">Layer Name</label>
                <input
                  type="text"
                  placeholder={`Layer ${customLayers.length + 1}`}
                  value={newLayerName}
                  onChange={e => setNewLayerName(e.target.value)}
                  className="gi-input"
                  style={{ height:36, padding:'0 10px' }}
                />
              </div>

              {/* Preset */}
              <div>
                <label className="gi-form-label">Insert Preset</label>
                <select
                  defaultValue=""
                  onChange={e => {
                    const preset = PRESET_QUERIES.find(p => p.label === e.target.value)
                    if (!preset) return
                    setNewLayerName(prev => prev || preset.name)
                    setNewLayerQuery(preset.query)
                    setAddError(null)
                    e.target.value = ''
                  }}
                  className="gi-select">
                  <option value="" disabled>— choose a preset —</option>
                  {PRESET_QUERIES.map(p => (
                    <option key={p.label} value={p.label}>{p.label}</option>
                  ))}
                </select>
              </div>

              {/* Query */}
              <div>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8, flexWrap:'wrap' }}>
                  <label className="gi-form-label" style={{ margin:0 }}>SQL Query</label>
                  <span className="gi-hint gi-hint-blue" style={{ padding:'2px 7px', margin:0, fontSize:10 }}>
                    use <code style={{ fontFamily:'monospace', background:'transparent' }}>{'{bound}'}</code> in WHERE to clip to active bound
                  </span>
                </div>
                {/* Schema reference */}
                <div style={{ display:'flex', flexWrap:'wrap', gap:'4px 10px', marginBottom:10 }}>
                  {[
                    { label:'hex', color:'#1d4ed8', bg:'rgba(29,78,216,0.12)', cols:['hex','colour','height'] },
                    { label:'pin', color:'#065f46', bg:'rgba(6,95,70,0.12)', cols:['lat','long','category','name'] },
                    { label:'scatter', color:'#5b21b6', bg:'rgba(91,33,182,0.12)', cols:['lat','long','radius','colour*'] },
                    { label:'polygon', color:'#92400e', bg:'rgba(146,64,14,0.12)', cols:['geo_json','tooltip','colour*'] },
                  ].map(({ label, color, bg, cols }) => (
                    <div key={label} style={{ display:'inline-flex', alignItems:'center', gap:5 }}>
                      <span style={{ background:bg, color, borderRadius:4, padding:'2px 6px', fontSize:10, fontWeight:700 }}>{label}</span>
                      {cols.map(c => <span key={c} className="gi-col-tag">{c}</span>)}
                    </div>
                  ))}
                </div>
                <div className="sql-editor-chrome">
                  <SqlEditor
                    value={newLayerQuery}
                    onChange={v => { setNewLayerQuery(v); setAddError(null) }}
                  />
                </div>
              </div>

              {addError && <Hint red>{addError}</Hint>}
            </div>

            {/* Footer */}
            <div className="gi-modal-footer">
              <button onClick={() => setShowAddModal(false)}
                className="gi-btn gi-btn-ghost" style={{ padding:'8px 18px', fontSize:13 }}>
                Cancel
              </button>
              <button
                onClick={handleAddLayer}
                disabled={addLoading || !newLayerQuery.trim()}
                className="gi-btn gi-btn-primary"
                style={{ padding:'8px 22px', fontSize:13 }}>
                {addLoading ? <><LoadSpinner /> Running…</> : editingLayerId ? 'Update & Run' : 'Run & Add'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tiny presentational components ───────────────────────────────────────
function SectionTitle({ children, top }) {
  return (
    <div style={{
      fontWeight:700, fontSize:12, color:'var(--gi-text)', marginBottom:10,
      letterSpacing:'0.02em',
      ...(top ? { marginTop:12, paddingTop:10, borderTop:'1px solid var(--gi-border)' } : {}),
    }}>{children}</div>
  )
}

function CheckRow({ label, checked, onChange }) {
  return (
    <label style={row}>
      <span style={lbl}>{label}</span>
      <input type="checkbox" checked={checked} onChange={e=>onChange(e.target.checked)}
        style={{ accentColor:'var(--gi-blue)', width:14, height:14, cursor:'pointer' }} />
    </label>
  )
}

// Compact slider with gradient fill track
function MiniRange({ label, min, max, step, value, fmt, onChange }) {
  const pct = ((value - min) / (max - min)) * 100
  const bg  = `linear-gradient(to right, var(--gi-blue) ${pct}%, var(--gi-border-default) ${pct}%)`
  return (
    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
      <span style={{ width:62, fontSize:11, fontWeight:500, color:'var(--gi-text-muted)', flexShrink:0 }}>{label}</span>
      <input type="range" className="geo-slider" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ flex:1, background:bg }} />
      <span style={{ width:36, textAlign:'right', fontSize:11, fontWeight:600,
        color:'var(--gi-text-dim)', flexShrink:0, fontVariantNumeric:'tabular-nums' }}>{fmt(value)}</span>
    </div>
  )
}

// ── Minimal SVG icon components ───────────────────────────────────────────
function EyeIcon({ open }) {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M1 7.5S3.5 3 7.5 3s6.5 4.5 6.5 4.5S11.5 12 7.5 12 1 7.5 1 7.5z"
        stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
      <circle cx="7.5" cy="7.5" r="1.8" fill="currentColor"/>
      {!open && <line x1="2" y1="2" x2="13" y2="13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>}
    </svg>
  )
}

function DragIcon() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      {[2,6,10].map(y => (
        <g key={y}>
          <circle cx="3" cy={y} r="1.1" fill="currentColor"/>
          <circle cx="7" cy={y} r="1.1" fill="currentColor"/>
        </g>
      ))}
    </svg>
  )
}

function ChevronIcon({ up }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d={up ? 'M2 8l4-4 4 4' : 'M2 4l4 4 4-4'}
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function LoadSpinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg"
      style={{ animation:'spin 0.9s linear infinite', flexShrink:0 }}>
      <circle cx="7" cy="7" r="5.5" stroke="var(--gi-border-default)" strokeWidth="2" fill="none"/>
      <path d="M7 1.5A5.5 5.5 0 0 1 12.5 7" stroke="var(--gi-blue)" strokeWidth="2"
        fill="none" strokeLinecap="round"/>
    </svg>
  )
}

// ── CodeMirror-backed SQL editor ──────────────────────────────────────────
function SqlEditor({ value, onChange }) {
  const containerRef = useRef(null)
  const cmRef        = useRef(null)

  // Initialise CodeMirror once on mount
  useEffect(() => {
    const CM = window.CodeMirror
    if (!containerRef.current || !CM) return

    // React StrictMode mounts twice — wipe any leftover DOM from the first run
    containerRef.current.innerHTML = ''

    const cm = CM(containerRef.current, {
      value:             value ?? '',
      mode:              'text/x-sql',
      theme:             'dracula',
      lineNumbers:       true,
      tabSize:           2,
      indentWithTabs:    false,
      lineWrapping:      true,
      autofocus:         true,
      matchBrackets:     true,
      autoCloseBrackets: true,
      extraKeys: {
        Tab:      instance => instance.replaceSelection('  '),
        'Ctrl-/': 'toggleComment',
        'Cmd-/':  'toggleComment',
      },
    })

    cm.setSize('100%', 200)
    // brief defer so the modal's flex layout settles before CodeMirror measures
    setTimeout(() => cm.refresh(), 30)

    cm.on('change', inst => onChange(inst.getValue()))
    cmRef.current = cm

    return () => {
      // Clear the container so a re-mount starts with an empty div
      if (containerRef.current) containerRef.current.innerHTML = ''
      cmRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep editor in sync when value changes externally (edit-mode pre-fill)
  useEffect(() => {
    const cm = cmRef.current
    if (cm && cm.getValue() !== value) {
      const cursor = cm.getCursor()
      cm.setValue(value ?? '')
      cm.setCursor(cursor)
    }
  }, [value])

  return (
    <div>
      {/* Faux window-chrome title bar */}
      <div className="sql-editor-header">
        <span className="sql-editor-dot" style={{ background:'#ff5f57' }}/>
        <span className="sql-editor-dot" style={{ background:'#febc2e' }}/>
        <span className="sql-editor-dot" style={{ background:'#28c840' }}/>
        <span style={{ flex:1 }}/>
        <span style={{ fontSize:10, color:'#6272a4', fontFamily:'monospace', letterSpacing:'0.05em' }}>SQL</span>
      </div>
      <div className="sql-editor" ref={containerRef}/>
    </div>
  )
}

function RangeRow({ label, min, max, step, value, fmt, onChange, last }) {
  const pct = ((value - min) / (max - min)) * 100
  const bg  = `linear-gradient(to right, var(--gi-blue) ${pct}%, var(--gi-border-default) ${pct}%)`
  return (
    <div style={{ ...row, ...(last?{borderBottom:'none',paddingBottom:0,marginBottom:0}:{}) }}>
      <span style={lbl}>{label}</span>
      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
        <input type="range" className="geo-slider" min={min} max={max} step={step} value={value}
          onChange={e=>onChange(Number(e.target.value))}
          style={{ width:84, background:bg }} />
        <span style={{ width:34, textAlign:'right', fontSize:11, color:'var(--gi-text-dim)' }}>{fmt(value)}</span>
      </div>
    </div>
  )
}

function Hint({ children, blue, green, red }) {
  const cls = blue ? 'gi-hint-blue' : green ? 'gi-hint-green' : red ? 'gi-hint-red' : 'gi-hint-neutral'
  return <div className={`gi-hint ${cls}`} style={{ marginBottom:6 }}>{children}</div>
}

function BtnRow({ children }) {
  return <div style={{ display:'flex', flexDirection:'column', gap:5, marginBottom:4 }}>{children}</div>
}

const VARIANT = {
  primary: { background:'var(--gi-blue)',    color:'#fff', border:'none' },
  danger:  { background:'var(--gi-red)',      color:'#fff', border:'none' },
  success: { background:'var(--gi-green)',    color:'#fff', border:'none' },
  save:    { background:'#7c3aed',            color:'#fff', border:'none' },
  outline: { background:'var(--gi-card)',     color:'var(--gi-text-dim)', border:'1px solid var(--gi-border-default)' },
}
function Btn({ children, variant='primary', onClick, disabled, style }) {
  return (
    <button disabled={disabled} onClick={onClick}
      style={{ ...btn, ...VARIANT[variant], ...style }}>
      {children}
    </button>
  )
}