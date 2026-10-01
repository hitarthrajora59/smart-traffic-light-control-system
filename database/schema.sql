CREATE TABLE IF NOT EXISTS traffic_telemetry (
  id BIGSERIAL PRIMARY KEY,
  device_id VARCHAR(64) NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  north_cm NUMERIC(8,2),
  east_cm NUMERIC(8,2),
  north_count INTEGER,
  east_count INTEGER,
  ns_signal VARCHAR(8),
  ew_signal VARCHAR(8),
  remaining_sec INTEGER,
  mode VARCHAR(24),
  access_granted BOOLEAN DEFAULT FALSE,
  raw JSONB
);
CREATE INDEX IF NOT EXISTS idx_traffic_telemetry_ts ON traffic_telemetry(ts DESC);
