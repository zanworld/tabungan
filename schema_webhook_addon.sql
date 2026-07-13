-- Jalankan query ini di Supabase SQL Editor SETELAH schema.sql yang lama
-- (dashboard.supabase.com → project → SQL Editor → New Query)
--
-- Kenapa ini perlu: bot lama nyimpen "lagi nunggu input apa" (waiting) dan
-- "id pesan yang lagi di-edit" (mainMsg) di variabel JS biasa di memory.
-- Itu OK selama proses Node-nya nyala terus (kayak di Railway). Begitu bot
-- pindah ke Vercel serverless (tiap update masuk = eksekusi baru, memory
-- nggak dijamin nyambung), state itu HARUS disimpen di database, bukan
-- di memory — makanya ada 2 tabel baru ini.

CREATE TABLE bot_waiting (
  user_id     BIGINT PRIMARY KEY,
  state       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE bot_mainmsg (
  chat_id     BIGINT PRIMARY KEY,
  message_id  BIGINT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE bot_waiting ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_mainmsg ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_all" ON bot_waiting FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON bot_mainmsg FOR ALL USING (true) WITH CHECK (true);
