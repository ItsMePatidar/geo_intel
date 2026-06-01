from terracatalogueclient import Catalogue
from shapely.geometry import Polygon
import json

# Authenticate (browser login)
catalogue = Catalogue().authenticate()

with open('/Users/priyanshpatidar/Documents/FPL/H3_Data_Construction/polygon.json', 'r') as file:
    data = json.load(file)

# Define area of interest (bbox: minx, miny, maxx, maxy)
# bounds = (18.4, 73.7, 18.7, 74.0)
geometry = Polygon([tuple(i[::-1]) for i in data['coordinates'][0]])

# Get products for that region
products = catalogue.get_products(
    "urn:eop:VITO:ESA_WorldCover_10m_2020_V1",
    geometry=geometry
)
print(products)
# Download
catalogue.download_products(products, "WorldCover/Data")