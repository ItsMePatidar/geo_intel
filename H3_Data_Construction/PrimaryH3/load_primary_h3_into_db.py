import json
import random
import psycopg2
import h3

# Load polygon data from JSON
with open('/Users/priyanshpatidar/Documents/FPL/H3_Data_Construction/polygon.json', 'r') as file:
    data = json.load(file)

# Prepare polygon coordinates (reverse each [lng, lat] to [lat, lng])
my_polygon = [coord for coord in data['coordinates'][0]]

def insert_polygon_h3(polygon_coords, resolution):
    conn = psycopg2.connect(
        dbname='geointel_local',
        user='postgres',
        password='password',
        host='localhost',
        port=5432
    )
    try:
        cur = conn.cursor()

        # Generate H3 cells
        hexes = list(h3.polygon_to_cells(h3.LatLngPoly(polygon_coords), resolution))

        count_array = [0 for i in hexes]
        print('Both array has been created successfully.')
        # Insert into database
        query = """
            INSERT INTO h3cells (hex, count)
            SELECT unnest(%s::text[]), unnest(%s::int[])
        """
        cur.execute(query, (hexes, count_array))
        print(f"Successfully inserted {cur.rowcount} rows.")

        conn.commit()
        cur.close()
    except Exception as e:
        print("Error:", e)
    finally:
        conn.close()

insert_polygon_h3(my_polygon, 9)