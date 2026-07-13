-- Jalankan query ini di Supabase SQL Editor
-- dashboard.supabase.com → project → SQL Editor → New Query

-- Tabel transaksi
CREATE TABLE transaksi (
  id          BIGSERIAL PRIMARY KEY,
  chat_id     BIGINT NOT NULL,
  telegram_id BIGINT NOT NULL,
  nama        TEXT NOT NULL,
  jumlah      INTEGER NOT NULL CHECK (jumlah > 0),
  keterangan  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Index biar query cepat
CREATE INDEX idx_transaksi_chat_id ON transaksi(chat_id);
CREATE INDEX idx_transaksi_created_at ON transaksi(created_at DESC);

-- Tabel target tabungan
CREATE TABLE target (
  id         BIGSERIAL PRIMARY KEY,
  chat_id    BIGINT UNIQUE NOT NULL,
  jumlah     INTEGER NOT NULL CHECK (jumlah > 0),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security (RLS) — opsional tapi recommended
ALTER TABLE transaksi ENABLE ROW LEVEL SECURITY;
ALTER TABLE target ENABLE ROW LEVEL SECURITY;

-- Policy: izinkan semua operasi via service role (bot kamu)
CREATE POLICY "allow_all" ON transaksi FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON target FOR ALL USING (true) WITH CHECK (true);
