import json
from shapely.geometry import Polygon

with open('/Users/priyanshpatidar/Documents/FPL/H3_Data_Construction/polygon.json', 'r') as file:
    data = json.load(file)

print([tuple(i[::-1]) for i in data['coordinates'][0][0][:5]])