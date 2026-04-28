from __future__ import annotations

PRICING_SCHEMA_DDL = """
CREATE TABLE IF NOT EXISTS pricing_channels (
    id BIGSERIAL PRIMARY KEY,
    channel_code TEXT NOT NULL UNIQUE,
    channel_name TEXT NOT NULL,
    transport_mode TEXT NOT NULL CHECK (transport_mode IN ('air', 'sea')),
    cargo_natures TEXT[] NOT NULL DEFAULT ARRAY['general'],
    destination_country TEXT,
    destination_scope TEXT NOT NULL DEFAULT 'any',
    tax_included BOOLEAN,
    destination_keyword TEXT,
    source_workbook TEXT,
    source_company TEXT,
    transit_days_min INTEGER,
    transit_days_max INTEGER,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    note TEXT
);

CREATE TABLE IF NOT EXISTS pricing_rate_tiers (
    id BIGSERIAL PRIMARY KEY,
    channel_id BIGINT NOT NULL REFERENCES pricing_channels(id) ON DELETE CASCADE,
    min_weight NUMERIC(12, 3) NOT NULL,
    max_weight NUMERIC(12, 3),
    unit_price NUMERIC(12, 4) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'CNY',
    volumetric_divisor NUMERIC(12, 3),
    min_charge NUMERIC(12, 2) NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS pricing_constraints (
    id BIGSERIAL PRIMARY KEY,
    channel_id BIGINT NOT NULL REFERENCES pricing_channels(id) ON DELETE CASCADE,
    max_gross_weight NUMERIC(12, 3),
    max_length NUMERIC(12, 3),
    max_width NUMERIC(12, 3),
    max_height NUMERIC(12, 3),
    max_l_plus_w_plus_h NUMERIC(12, 3),
    note TEXT
);

ALTER TABLE pricing_channels
  ADD COLUMN IF NOT EXISTS destination_country TEXT;

ALTER TABLE pricing_channels
  ADD COLUMN IF NOT EXISTS destination_scope TEXT NOT NULL DEFAULT 'any';

ALTER TABLE pricing_channels
  ADD COLUMN IF NOT EXISTS tax_included BOOLEAN;

ALTER TABLE pricing_channels
  ADD COLUMN IF NOT EXISTS source_workbook TEXT;

ALTER TABLE pricing_channels
  ADD COLUMN IF NOT EXISTS source_company TEXT;
"""

PRICING_INDEX_DDL = """
CREATE INDEX IF NOT EXISTS idx_pricing_channels_mode_active
    ON pricing_channels(transport_mode, active);

CREATE INDEX IF NOT EXISTS idx_pricing_rate_tiers_channel_active
    ON pricing_rate_tiers(channel_id, active);

CREATE INDEX IF NOT EXISTS idx_pricing_constraints_channel
    ON pricing_constraints(channel_id);
"""


def ensure_pricing_schema(conn, include_indexes: bool = False) -> None:
    ddl = PRICING_SCHEMA_DDL
    if include_indexes:
        ddl = f"{ddl}\n{PRICING_INDEX_DDL}"
    with conn.cursor() as cur:
        cur.execute(ddl)
    conn.commit()


def ensure_pricing_schema_with_engine(engine, include_indexes: bool = False) -> None:
    """通过 SQLAlchemy sync engine 执行 schema 初始化。"""

    raw_conn = engine.raw_connection()
    try:
        ensure_pricing_schema(raw_conn, include_indexes=include_indexes)
    finally:
        raw_conn.close()

