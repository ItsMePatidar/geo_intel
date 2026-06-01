const { Client } = require('pg');
const h3 = require('h3-js');

async function fillCityWithH3(cityPolygon, resolution) {
    // 1. Generate every hex cell that fits inside the city polygon
    // Note: polygonCoords must be [[lat, lng], [lat, lng], ...] 
    // and must be closed (first and last point same)
    const client = new Client({
            user: 'postgres',
            host: 'localhost',
            database: 'geointel_local',
            password: 'password',
            port: 5432,
        });
    const allHexes = h3.polygonToCells(cityPolygon, resolution);

    console.log(`Generated ${allHexes.length} hexagons at resolution ${resolution}`);

    // 2. Insert into your Postgres table
    const query = `
        INSERT INTO h3cells (hex, count)
        SELECT h, 1 FROM unnest($1::text[]) AS h
    `;
    
    try {
        await client.query(query, [allHexes]);
        console.log("City grid successfully saved.");
    } catch (err) {
        console.error(err);
    }
}
const punePolygon = [
    [18.5913, 73.7381], // Northwest (Baner/Balewadi area)
    [18.6225, 73.8166], // North (Pimpri-Chinchwad border)
    [18.5590, 73.9130], // Northeast (Viman Nagar/Kharadi)
    [18.4966, 73.9413], // Southeast (Hadapsar area)
    [18.4529, 73.8773], // South (Katraj area)
    [18.4900, 73.7570], // Southwest (Warje area)
    [18.5913, 73.7381]  // Closing the loop
];
fillCityWithH3(punePolygon, 7);