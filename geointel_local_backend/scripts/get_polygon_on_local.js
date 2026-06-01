const fs = require('fs');
const h3 = require('h3-js');

/**
 * Given polygon coordinates and resolution, generate H3 hexagons and save to CSV with random counts.
 * @param {Array<Array<number>>} polygonCoords - Array of [lat, lng] pairs.
 * @param {number} resolution - H3 resolution.
 * @param {string} outputPath - Path to output CSV file.
 */
function savePolygonH3WithRandomCountToCSV(polygonCoords, resolution, outputPath) {
    // 1. Generate the H3 cells
    const hexes = h3.polygonToCells(polygonCoords, resolution);

    // 2. Prepare CSV content (header + rows with random count)
    const header = 'hex,count\n';
    const rows = hexes.map(h => `${h},${Math.floor(Math.random() * 20) + 1}\n`).join('');
    const csvContent = header + rows;

    // 3. Write to file
    fs.writeFileSync(outputPath, csvContent, 'utf8');
    console.log(`Saved ${hexes.length} hexes with random counts to ${outputPath}`);
}

// Example polygon (same as in populate-h3.js)
const myPolygon = [
    [19.018, 72.820], // Northwest (Baner/Balewadi area)
    [19.018, 72.845], // North (Pimpri-Chinchwad border)
    [19.000, 72.845], // Northeast (Viman Nagar/Kharadi)
    [19.000, 72.820]
];
savePolygonH3WithRandomCountToCSV(myPolygon, 9, './h3cells.csv');