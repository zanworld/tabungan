const { createClient } = require("@supabase/supabase-js");
const https = require("https");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const PASSWORD = process.env.DASHBOARD_PASSWORD;
const OPENROUTER_KEY = process.env.OPENROUTER_KEY;

// OpenRouter rotates/retires its free-tier models often (the previous
// default, google/gemini-2.0-flash-exp:free, disappeared entirely — "No
// endpoints found"). Try OPENROUTER_MODEL first if set, then fall back
// through a short list of other free vision-capable models instead of
// hard-depending on any single one.
const OPENROUTER_MODELS = [
  process.env.OPENROUTER_MODEL,
  "nvidia/nemotron-nano-12b-v2-vl:free",   // vision-language, tuned for document/OCR tasks
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
].filter(Boolean);

// plain parseInt() truncates at the first non-digit — the model sometimes
// formats the nominal with a "." thousands separator (e.g. "50.000") despite
// the prompt asking it not to, so parseInt("50.000") silently returns 50
// instead of 50000. Strip every non-digit before parsing instead.
const parseNominal = (str) => parseInt(String(str).replace(/[^0-9]/g, ""), 10);

function callOpenRouter(model, base64, mimeType, prompt) {
  const body = JSON.stringify({
    model,
    temperature: 0,
    max_tokens: 50,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
      ],
    }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "openrouter.ai",
      path: "/api/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": `Bearer ${OPENROUTER_KEY}`,
        "HTTP-Referer": "https://github.com/zanworld/tabungan",
        "X-Title": "Tabungan Bareng",
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            const err = new Error(`OpenRouter API error ${json.error.code}: ${json.error.message}`);
            err.noEndpoints = json.error.code === 404 && /no endpoints found/i.test(json.error.message || "");
            return reject(err);
          }
          const choice = json.choices?.[0];
          if (!choice) {
            return reject(new Error(`OpenRouter returned no choices: ${data.slice(0, 500)}`));
          }
          if (choice.finish_reason && !["stop", "length"].includes(choice.finish_reason)) {
            return reject(new Error(`OpenRouter finish_reason: ${choice.finish_reason}`));
          }
          const text = choice.message?.content?.trim() || "TIDAK_DITEMUKAN";
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Sama persis logic-nya kayak extractNominalFromImage di lib/bot.js, biar
// hasil scan dari web dan dari Telegram konsisten. Lewat OpenRouter (bukan
// Gemini langsung) supaya bisa pakai model vision gratis tanpa perlu ngurus
// billing/quota Google Cloud sendiri.
async function extractNominalFromImage(base64, mimeType) {
  const prompt = `Kamu membantu tracking tabungan. Lihat gambar ini dan ekstrak nominal uang yang ditabung/ditransfer.

Aturan:
- Cari angka nominal transfer, pembayaran, atau tabungan
- Abaikan biaya admin, saldo sebelumnya, atau saldo akhir
- Kembalikan HANYA angka bulat tanpa titik/koma/Rp, contoh: 50000
- Kalau ada beberapa nominal, ambil yang paling relevan (nominal transfer utama)
- Kalau tidak ada nominal yang jelas, kembalikan: TIDAK_DITEMUKAN

Jawab hanya dengan angka atau TIDAK_DITEMUKAN.`;

  let lastErr;
  for (const model of OPENROUTER_MODELS) {
    try {
      return await callOpenRouter(model, base64, mimeType, prompt);
    } catch (e) {
      lastErr = e;
      if (!e.noEndpoints) throw e; // real error (auth, quota, etc) — don't mask it by trying more models
      console.error(`Model ${model} unavailable, trying next:`, e.message);
    }
  }
  throw lastErr;
}

// Browser punya nggak punya identitas Telegram, jadi transaksi/target yang
// ditambah dari web harus "menumpang" chat_id yang udah dipakai bot —
// kalau nggak, data itu jadi invisible buat bot sendiri (query bot selalu
// filter .eq("chat_id", ...)). Ambil chat_id terakhir yang pernah dipakai;
// fallback ke 0 kalau dashboard dipakai duluan sebelum ada aktivitas bot.
async function resolveChatId() {
  const { data: t } = await supabase.from("transaksi").select("chat_id").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (t?.chat_id != null) return t.chat_id;
  const { data: g } = await supabase.from("target").select("chat_id").limit(1).maybeSingle();
  if (g?.chat_id != null) return g.chat_id;
  return 0;
}

async function buildSaldo() {
  const { data } = await supabase.from("transaksi").select("nama,jumlah");
  const { data: tRow } = await supabase.from("target").select("jumlah").limit(1).maybeSingle();
  const target = tRow?.jumlah || 0;

  if (!data?.length) {
    return { empty: true, total: 0, perOrang: [], target, targetPct: null, sisa: null };
  }
  const perOrangMap = {};
  data.forEach((t) => { perOrangMap[t.nama] = (perOrangMap[t.nama] || 0) + t.jumlah; });
  const total = data.reduce((s, t) => s + t.jumlah, 0);
  const perOrang = Object.entries(perOrangMap)
    .sort((a, b) => b[1] - a[1])
    .map(([nama, jumlah]) => ({ nama, total: jumlah, pct: Math.round((jumlah / total) * 100) }));

  const targetPct = target > 0 ? Math.min(100, Math.round((total / target) * 100)) : null;
  const sisa = target > 0 ? Math.max(0, target - total) : null;
  return { empty: false, total, perOrang, target, targetPct, sisa };
}

async function buildRiwayat(limit) {
  const { data } = await supabase.from("transaksi").select("*").order("created_at", { ascending: false }).limit(limit);
  return data || [];
}

async function buildStatistik() {
  const { data } = await supabase.from("transaksi").select("*").order("created_at", { ascending: true });
  const { data: tRow } = await supabase.from("target").select("jumlah").limit(1).maybeSingle();
  const target = tRow?.jumlah || 0;

  if (!data?.length) {
    return { empty: true, total: 0, perOrang: [], hariMenabung: 0, avgHarian: 0, totalTransaksi: 0, target, sisa: null, estimasiHari: null };
  }
  const total = data.reduce((s, t) => s + t.jumlah, 0);
  const perOrangMap = {};
  data.forEach((t) => {
    if (!perOrangMap[t.nama]) perOrangMap[t.nama] = { total: 0, count: 0, max: 0, min: Infinity };
    const p = perOrangMap[t.nama];
    p.total += t.jumlah; p.count++; p.max = Math.max(p.max, t.jumlah); p.min = Math.min(p.min, t.jumlah);
  });
  const hari = Math.max(1, Math.ceil((new Date() - new Date(data[0].created_at)) / 86400000));
  const avgHarian = Math.round(total / hari);
  const perOrang = Object.entries(perOrangMap).map(([nama, s]) => ({
    nama, total: s.total, count: s.count, max: s.max, min: s.min,
    pct: Math.round((s.total / total) * 100), avg: Math.round(s.total / s.count),
  }));

  let sisa = null, estimasiHari = null;
  if (target > 0) {
    sisa = Math.max(0, target - total);
    estimasiHari = sisa > 0 ? Math.ceil(sisa / avgHarian) : 0;
  }
  return { empty: false, total, perOrang, sejakTanggal: data[0].created_at, hariMenabung: hari, avgHarian, totalTransaksi: data.length, target, sisa, estimasiHari };
}

async function buildTarget() {
  const { data: tRow } = await supabase.from("target").select("jumlah").limit(1).maybeSingle();
  const { data: all } = await supabase.from("transaksi").select("jumlah");
  const total = all?.reduce((s, t) => s + t.jumlah, 0) || 0;

  if (!tRow) return { isSet: false, jumlah: 0, total, pct: null, sisa: null };
  const pct = Math.min(100, Math.round((total / tRow.jumlah) * 100));
  const sisa = Math.max(0, tRow.jumlah - total);
  return { isSet: true, jumlah: tRow.jumlah, total, pct, sisa };
}

async function handleGet(req, res) {
  const limit = parseInt(req.query?.limit) || 30;
  const [saldo, riwayat, statistik, target] = await Promise.all([
    buildSaldo(), buildRiwayat(limit), buildStatistik(), buildTarget(),
  ]);
  res.status(200).json({ ok: true, saldo, riwayat, statistik, target });
}

async function handlePost(req, res) {
  const body = req.body || {};

  if (body.action === "nabung") {
    const nama = String(body.nama || "").trim();
    const jumlah = parseInt(body.jumlah);
    if (!nama || !Number.isInteger(jumlah) || jumlah <= 0) {
      return res.status(400).json({ ok: false, error: "Nama atau nominal belum valid, coba cek lagi" });
    }
    const chatId = await resolveChatId();
    const keterangan = body.keterangan ? String(body.keterangan).trim() || null : null;
    const { error } = await supabase.from("transaksi").insert({ chat_id: chatId, telegram_id: 0, nama, jumlah, keterangan });
    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.status(200).json({ ok: true });
  }

  if (body.action === "hapus") {
    const id = parseInt(body.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: "id tidak valid" });
    const { data, error } = await supabase.from("transaksi").delete().eq("id", id).select();
    if (error) return res.status(500).json({ ok: false, error: error.message });
    if (!data?.length) return res.status(404).json({ ok: false, error: "not_found" });
    return res.status(200).json({ ok: true, deleted: data[0] });
  }

  if (body.action === "target") {
    const jumlah = parseInt(body.jumlah);
    if (!Number.isInteger(jumlah) || jumlah <= 0) return res.status(400).json({ ok: false, error: "jumlah tidak valid" });
    const { data: existing } = await supabase.from("target").select("id").limit(1).maybeSingle();
    if (existing) {
      const { error } = await supabase.from("target").update({ jumlah, updated_at: new Date().toISOString() }).eq("id", existing.id);
      if (error) return res.status(500).json({ ok: false, error: error.message });
    } else {
      const chatId = await resolveChatId();
      const { error } = await supabase.from("target").insert({ chat_id: chatId, jumlah });
      if (error) return res.status(500).json({ ok: false, error: error.message });
    }
    return res.status(200).json({ ok: true });
  }

  if (body.action === "scan") {
    if (!OPENROUTER_KEY) return res.status(500).json({ ok: false, error: "OPENROUTER_KEY belum diset" });
    const image = String(body.image || "");
    if (!image) return res.status(400).json({ ok: false, error: "image tidak ada" });
    if (image.length > 8_000_000) return res.status(400).json({ ok: false, error: "gambar terlalu besar" });

    try {
      const result = await extractNominalFromImage(image, body.mimeType || "image/jpeg");
      const jumlah = parseNominal(result);
      if (result === "TIDAK_DITEMUKAN" || isNaN(jumlah) || jumlah <= 0) {
        return res.status(200).json({ ok: true, detected: false });
      }
      return res.status(200).json({ ok: true, detected: true, jumlah });
    } catch (err) {
      console.error("Scan error:", err);
      return res.status(500).json({ ok: false, error: "scan_failed" });
    }
  }

  return res.status(400).json({ ok: false, error: "unknown_action" });
}

module.exports = async (req, res) => {
  if (!PASSWORD) return res.status(500).json({ ok: false, error: "DASHBOARD_PASSWORD not configured" });
  if (req.headers["x-dashboard-password"] !== PASSWORD) return res.status(401).json({ ok: false, error: "unauthorized" });

  try {
    if (req.method === "GET") return await handleGet(req, res);
    if (req.method === "POST") return await handlePost(req, res);
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  } catch (err) {
    console.error("Dashboard API error:", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
};
