# postgres:16 (Debian) + PostGIS installed via apt.
# apt puts the .control file and shared libs exactly where the Docker
# PostgreSQL server expects them — unlike apk, which targets a different path.
# This image is multi-arch (amd64 + arm64) so it works on Apple Silicon too.
FROM postgres:16

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        postgresql-16-postgis-3 \
        postgresql-16-postgis-3-scripts \
    && rm -rf /var/lib/apt/lists/*
