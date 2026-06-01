# Data-loader image: Python 3.11 + GDAL (for rasterio) + project dependencies
FROM python:3.11-slim

# Install GDAL, osmium native libs, and build tools via apt
RUN apt-get update && apt-get install -y --no-install-recommends \
        gdal-bin \
        libgdal-dev \
        osmium-tool \
        libosmium-dev \
        libprotozero-dev \
        libboost-dev \
        zlib1g-dev \
        gcc \
        g++ \
    && rm -rf /var/lib/apt/lists/*

# Tell rasterio / pip where to find GDAL headers
ENV CPLUS_INCLUDE_PATH=/usr/include/gdal
ENV C_INCLUDE_PATH=/usr/include/gdal

WORKDIR /app

# Install Python dependencies first (cached layer)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy scripts (data files are mounted at runtime — not baked in)
COPY . .

RUN chmod +x run_all.sh

# Default: run all loaders in order.
# Override with a specific script to run just one step, e.g.
#   docker compose --profile load run loader python PrimaryH3/load_base_into_db.py
CMD ["bash", "run_all.sh"]
