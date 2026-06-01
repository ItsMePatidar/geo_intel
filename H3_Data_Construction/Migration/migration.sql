-- Enable PostGIS extension (required for ST_MakePoint, ST_Within, ST_GeomFromGeoJSON, etc.)
CREATE EXTENSION IF NOT EXISTS postgis;

-- Table 1 : Base H3 Data

CREATE TABLE base (
    h3_index character varying(32) COLLATE pg_catalog."default" NOT NULL,
    resolution INT,
    lat numeric(9,6) NOT NULL,
    long numeric(9,6) NOT NULL,
    pincode BIGINT,
    circle  TEXT,
    city    TEXT,
    state   TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT pk_base PRIMARY KEY (h3_index)
);

CREATE INDEX idx_base_updated ON base (updated_at);

-- Table 2 : Population Table

CREATE TABLE population (
    h3_index character varying(32) COLLATE pg_catalog."default" NOT NULL,
    population BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT pk_population PRIMARY KEY (h3_index)
);

CREATE INDEX idx_population_updated ON population (updated_at);

-- Table 3 : Land Cover Table

CREATE TABLE land_cover (
    h3_index character varying(32) COLLATE pg_catalog."default" NOT NULL,
    dominant_class TEXT,
    class_count BIGINT,
    class_json JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT pk_land_cover PRIMARY KEY (h3_index)
);

CREATE INDEX idx_land_cover_updated ON land_cover (updated_at);

-- Table 4 : Merged H3 Table

CREATE TABLE h3_grids (
    h3_index character varying(32) COLLATE pg_catalog."default" NOT NULL,

    resolution INT,
    lat numeric(9,6) NOT NULL DEFAULT 0,
    long numeric(9,6) NOT NULL DEFAULT 0,
    pincode BIGINT,
    circle  TEXT,
    city    TEXT,
    state   TEXT,
    base_updated_at TIMESTAMPTZ,

    population BIGINT,
    population_updated_at TIMESTAMPTZ,

    dominant_class TEXT,
    class_count BIGINT,
    class_json JSONB,
    land_cover_updated_at TIMESTAMPTZ,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_modified_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT pk_h3_grids PRIMARY KEY (h3_index)
);

CREATE INDEX idx_h3_grids_base_updated  ON h3_grids (base_updated_at);
CREATE INDEX idx_h3_grids_population_updated   ON h3_grids (population_updated_at);
CREATE INDEX idx_h3_grids_land_cover_updated  ON h3_grids (land_cover_updated_at);

-- Trigger 1 : base -> h3_grids

CREATE OR REPLACE FUNCTION trg_merge_base()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO h3_grids (
        h3_index,
        resolution,
        lat,
        long,
        pincode,
        circle,
        city,
        state,
        base_updated_at,
        last_modified_at
    )
    VALUES (
        NEW.h3_index,
        NEW.resolution,
        NEW.lat,
        NEW.long,
        NEW.pincode,
        NEW.circle,
        NEW.city,
        NEW.state,
        NEW.updated_at,
        now()
    )
    ON CONFLICT (h3_index) DO UPDATE SET
        resolution      = EXCLUDED.resolution,
        lat             = EXCLUDED.lat,
        long            = EXCLUDED.long,
        pincode         = EXCLUDED.pincode,
        circle          = EXCLUDED.circle,
        city            = EXCLUDED.city,
        state           = EXCLUDED.state,
        base_updated_at = EXCLUDED.base_updated_at,
        last_modified_at = now();

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_after_base_upsert
AFTER INSERT OR UPDATE ON base
FOR EACH ROW
EXECUTE FUNCTION trg_merge_base();

-- Trigger 2 : population -> h3_grids

CREATE OR REPLACE FUNCTION trg_merge_population()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO h3_grids (
        h3_index,
        population,
        population_updated_at,
        last_modified_at
    )
    VALUES (
        NEW.h3_index,
        NEW.population,
        NEW.updated_at,
        now()
    )
    ON CONFLICT (h3_index) DO UPDATE SET
        population = EXCLUDED.population,
        population_updated_at = EXCLUDED.population_updated_at,
        last_modified_at = now();
 
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_after_population_upsert
AFTER INSERT OR UPDATE ON population
FOR EACH ROW
EXECUTE FUNCTION trg_merge_population();

-- Trigger 3 : land_cover -> h3_grids

CREATE OR REPLACE FUNCTION trg_merge_land_cover()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO h3_grids (
        h3_index,
        dominant_class,
        class_count,
        class_json,
        land_cover_updated_at,
        last_modified_at
    )
    VALUES (
        NEW.h3_index,
        NEW.dominant_class,
        NEW.class_count,
        NEW.class_json,
        NEW.updated_at,
        now()
    )
    ON CONFLICT (h3_index) DO UPDATE SET
        dominant_class = EXCLUDED.dominant_class,
        class_count = EXCLUDED.class_count,
        class_json = EXCLUDED.class_json,
        land_cover_updated_at = EXCLUDED.land_cover_updated_at,
        last_modified_at = now();
 
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_after_land_cover_upsert
AFTER INSERT OR UPDATE ON land_cover
FOR EACH ROW
EXECUTE FUNCTION trg_merge_land_cover();

-- Table 5 : Points of Interest

CREATE TABLE IF NOT EXISTS points (
    id        SERIAL PRIMARY KEY,
    lat       DECIMAL(9, 6)  NOT NULL,
    long      DECIMAL(9, 6)  NOT NULL,
    category  VARCHAR(100),
    name      VARCHAR(255)
);