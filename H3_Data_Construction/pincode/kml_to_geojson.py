from zipfile import ZipFile
import geopandas as gpd
import os

kmz_path = 'dd7bfd69-143e-462b-bfa3-2ac35d931342.kmz'

with ZipFile(kmz_path, 'r') as kmz:
    # Look for any file ending in .kml
    kml_filenames = [f for f in kmz.namelist() if f.endswith('.kml')]
    
    if not kml_filenames:
        raise ValueError("No KML file found inside the KMZ archive.")
    
    # Use the first KML file found
    target_kml = kml_filenames[0]
    kmz.extract(target_kml, 'temp_folder')
    kml_path = os.path.join('temp_folder', target_kml)

# Now read the extracted file
import fiona
fiona.drvsupport.supported_drivers['KML'] = 'rw'
gdf = gpd.read_file(kml_path, driver='KML')
