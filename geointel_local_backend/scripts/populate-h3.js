const data = require('/Users/priyanshpatidar/Documents/projects/geointel_local_backend/polygon.json');

const { Client } = require('pg');
const h3 = require('h3-js');

async function insertPolygonH3(polygonCoords, resolution) {
    const client = new Client({
        user: 'postgres',
        host: 'localhost',
        database: 'geointel_local',
        password: 'password',
        port: 5432,
    });

    try {
        await client.connect();

        // 1. Generate the H3 cells
        const hexes = h3.polygonToCells(polygonCoords, resolution);

        // 2. Prepare hexes with random counts between 1 and 20
        const hexesWithCounts = hexes.map(h => [h, Math.floor(Math.random() * 20) + 1]);

        // 3. The Query: Insert hex and count pairs
        const query = `
            INSERT INTO h3cells (hex, count)
            SELECT x.hex, x.count
            FROM UNNEST($1::text[], $2::int[]) AS x(hex, count)
        `;

        // Separate hexes and counts into two arrays
        const hexArray = hexesWithCounts.map(([h, c]) => h);
        const countArray = hexesWithCounts.map(([h, c]) => c);

        const values = [hexArray, countArray];

        const res = await client.query(query, values);
        console.log(`Successfully inserted ${res.rowCount} rows.`);

    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        await client.end();
    }
}

// Example: Triangle in San Francisco [lat, lng]
// const myPolygon = [
//     [18.882980, 73.435904],
//     [18.882980, 74.241726],
//     [18.321783, 74.241726],
//     [18.321783, 73.435904],
//     [18.882980, 73.435904],
// ]
myPolygon = data['coordinates'][0].map(i => [...i])

insertPolygonH3(myPolygon, 9);
