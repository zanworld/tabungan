const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const https = require("https");

// NOTE: no `{ polling: true }` here — on serverless, Telegram pushes updates to
// our webhook endpoint instead of us pulling them in a loop.
const bot = new TelegramBot(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ALLOWED = process.env.ALLOWED_CHAT_ID;
const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-exp:free";

// ── helpers ──────────────────────────────────────────────────────────────────
const IDR = (n) =>
  new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", minimumFractionDigits: 0 }).format(n);
const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
const barChart = (pct, len = 12) => {
  const f = Math.round((Math.min(pct, 100) / 100) * len);
  return "▓".repeat(f) + "░".repeat(len - f);
};
const sep = "━━━━━━━━━━━━━━━━━━━";

function allowed(id) { return !ALLOWED || ALLOWED.split(",").map(x => x.trim()).includes(String(id)); }
function nama(msg) { return msg.from.first_name || msg.from.username || "Kamu"; }

const parseAmount = (str) =>
  parseInt(String(str).toLowerCase().replace(/\./g, "").replace(/rb|ribu/g, "000").replace(/jt|juta/g, "000000").replace(/[^0-9]/g, ""));

// ── Persistent session state (Supabase-backed) ───────────────────────────────
// Replaces the old in-memory `waiting = {}` / `mainMsg = {}` objects. On
// serverless, each update can hit a totally fresh execution context, so any
// "what step is this user on" state MUST live outside process memory or it
// gets silently lost between messages (see schema_webhook_addon.sql).
async function getWaiting(userId) {
  const { data } = await supabase.from("bot_waiting").select("state").eq("user_id", userId).maybeSingle();
  return data?.state || null;
}
async function setWaiting(userId, state) {
  await supabase.from("bot_waiting").upsert({ user_id: userId, state, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
}
async function clearWaiting(userId) {
  await supabase.from("bot_waiting").delete().eq("user_id", userId);
}
async function getMainMsg(chatId) {
  const { data } = await supabase.from("bot_mainmsg").select("message_id").eq("chat_id", chatId).maybeSingle();
  return data?.message_id || null;
}
async function setMainMsgId(chatId, messageId) {
  await supabase.from("bot_mainmsg").upsert({ chat_id: chatId, message_id: messageId, updated_at: new Date().toISOString() }, { onConflict: "chat_id" });
}
async function clearMainMsgId(chatId) {
  await supabase.from("bot_mainmsg").delete().eq("chat_id", chatId);
}

// ── Tombol navigasi bawah (selalu nempel di tiap menu) ────────────────────────
const navButtons = [
  [
    { text: "💰 Nabung", callback_data: "go_nabung" },
    { text: "📊 Saldo", callback_data: "go_saldo" },
  ],
  [
    { text: "📋 Riwayat", callback_data: "go_riwayat" },
    { text: "📈 Statistik", callback_data: "go_statistik" },
  ],
  [
    { text: "🎯 Target", callback_data: "go_target" },
    { text: "🗑 Hapus", callback_data: "go_hapus" },
  ],
];

// Kirim atau edit pesan utama
async function showMain(chatId, text, extraButtons = [], noNav = false) {
  const keyboard = { inline_keyboard: noNav ? extraButtons : [...extraButtons, ...navButtons] };
  const opts = { parse_mode: "Markdown", reply_markup: keyboard };

  const existingId = await getMainMsg(chatId);
  if (existingId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: existingId, ...opts });
      return;
    } catch (e) {
      // gagal edit (pesan terlalu lama / kehapus / isi sama) → hapus lalu kirim baru
      bot.deleteMessage(chatId, existingId).catch(() => {});
      await clearMainMsgId(chatId);
    }
  }
  const sent = await bot.sendMessage(chatId, text, opts);
  await setMainMsgId(chatId, sent.message_id);
}

// Toast singkat (auto-hilang feel) — dipakai utk notif kecil
const toast = (chatId, text) =>
  bot.sendMessage(chatId, text, { parse_mode: "Markdown" }).then(m => {
    setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => {}), 2500);
  });

// ── Helper animasi ────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Edit teks pesan utama tanpa keyboard (dipakai utk frame animasi)
async function editPlain(chatId, text) {
  const existingId = await getMainMsg(chatId);
  if (!existingId) return;
  try {
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: existingId, parse_mode: "Markdown",
    });
  } catch (e) {}
}

// Animasi loading dots: "Menyimpan" → "." → ".." → "..."
async function loadingDots(chatId, label = "Memproses") {
  const frames = [".", "..", "..."];
  for (const f of frames) {
    await editPlain(chatId, `⏳ _${label}${f}_`);
    await sleep(280);
  }
}

// Animasi progress bar ngisi bertahap sampai pct akhir
async function animateBar(chatId, headerText, targetPct, len = 14) {
  const steps = [0, 0.25, 0.5, 0.75, 1];
  for (const s of steps) {
    const cur = Math.round(targetPct * s);
    await editPlain(chatId, `${headerText}\n\`${barChart(cur, len)}\` *${cur}%*`);
    await sleep(220);
  }
}

// Splash screen pas /start — muncul bertahap
async function splash(chatId) {
  const frames = [
    "💕",
    "💕 *TABUNGAN*",
    "💕 *TABUNGAN BARENG*",
    "💕 *TABUNGAN BARENG*\n_memuat data..._",
  ];
  const existingId = await getMainMsg(chatId);
  if (!existingId) {
    const sent = await bot.sendMessage(chatId, frames[0], { parse_mode: "Markdown" });
    await setMainMsgId(chatId, sent.message_id);
  } else {
    await editPlain(chatId, frames[0]);
  }
  for (let i = 1; i < frames.length; i++) {
    await sleep(260);
    await editPlain(chatId, frames[i]);
  }
  await sleep(300);
}

// ── /start ────────────────────────────────────────────────────────────────────
async function handleStart(msg) {
  if (!allowed(msg.chat.id)) return;
  bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
  bot.sendChatAction(msg.chat.id, "typing").catch(() => {});
  await splash(msg.chat.id);
  await renderHome(msg.chat.id, nama(msg));
}

async function renderHome(chatId, namaUser = "") {
  const { data } = await supabase.from("transaksi").select("jumlah,telegram_id").eq("chat_id", chatId);
  const total = data?.reduce((s, t) => s + t.jumlah, 0) || 0;
  const { data: tRow } = await supabase.from("target").select("jumlah").eq("chat_id", chatId).single();
  const target = tRow?.jumlah || 0;

  let progressLine = "";
  if (target > 0) {
    const pct = Math.min(100, Math.round((total / target) * 100));
    progressLine = `\n🎯 \`${barChart(pct)}\` *${pct}%*\n_menuju ${IDR(target)}_`;
  }

  await showMain(chatId,
`💕 *TABUNGAN BARENG*
${namaUser ? `_Halo, ${namaUser}!_\n` : ""}${sep}
🏦 Total terkumpul
*${IDR(total)}*${progressLine}
${sep}
_Pilih menu di bawah_ 👇`
  );
}

// ── Callback handler ──────────────────────────────────────────────────────────
async function handleCallbackQuery(q) {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const namaUser = q.from.first_name || "Kamu";
  const d = q.data;
  if (!allowed(chatId)) { await bot.answerCallbackQuery(q.id).catch(() => {}); return; }

  // simpan id pesan utama
  await setMainMsgId(chatId, q.message.message_id);
  bot.answerCallbackQuery(q.id).catch(() => {});

  // ── Navigasi menu
  if (d === "go_home") { await clearWaiting(userId); return renderHome(chatId, namaUser); }
  if (d === "go_saldo") { await clearWaiting(userId); return renderSaldo(chatId); }
  if (d === "go_riwayat") { await clearWaiting(userId); return renderRiwayat(chatId); }
  if (d === "go_statistik") { await clearWaiting(userId); return renderStatistik(chatId); }
  if (d === "go_target") { await clearWaiting(userId); return renderTarget(chatId); }
  if (d === "go_hapus") { await clearWaiting(userId); return renderHapus(chatId, userId); }
  if (d === "go_nabung") { return renderNabungPicker(chatId, userId, namaUser); }

  // ── Pilih nominal cepat
  if (d.startsWith("nb_") && !["nb_custom", "nb_cancel"].includes(d)) {
    const jumlah = parseInt(d.replace("nb_", ""));
    await setWaiting(userId, { chatId, nama: namaUser, step: "keterangan", jumlah });
    return showMain(chatId,
`💰 *NABUNG*
${sep}
Nominal: *${IDR(jumlah)}*
${sep}
📝 _Ketik keterangan, atau Skip_`,
      [[
        { text: "⏭ Skip & Simpan", callback_data: `ket_skip_${jumlah}` },
        { text: "↩️ Batal", callback_data: "go_home" },
      ]]
    );
  }

  if (d === "nb_custom") {
    await setWaiting(userId, { chatId, nama: namaUser, step: "nominal_custom" });
    return showMain(chatId,
`💰 *NABUNG*
${sep}
✏️ _Ketik nominalnya:_
contoh: \`75000\`, \`75rb\`, \`1jt\``,
      [[{ text: "↩️ Batal", callback_data: "go_home" }]]
    );
  }

  // ── Skip keterangan
  if (d.startsWith("ket_skip_")) {
    const jumlah = parseInt(d.replace("ket_skip_", ""));
    await clearWaiting(userId);
    await simpanNabung(chatId, userId, namaUser, jumlah, null);
    return;
  }

  // ── Hapus
  if (d.startsWith("hapus_ok_")) {
    const id = parseInt(d.replace("hapus_ok_", ""));
    const { data: trx } = await supabase.from("transaksi").select("*").eq("id", id).single();
    if (trx) await supabase.from("transaksi").delete().eq("id", id);
    await toast(chatId, trx ? `🗑 Dihapus: ${IDR(trx.jumlah)}` : "❌ Tidak ditemukan");
    return renderHome(chatId, namaUser);
  }
}

// ── Render: Nabung picker ─────────────────────────────────────────────────────
async function renderNabungPicker(chatId, userId, namaUser) {
  await clearWaiting(userId);
  await showMain(chatId,
`💰 *NABUNG*
${sep}
_Pilih nominal cepat, atau ketik sendiri_`,
    [
      [
        { text: "5rb", callback_data: "nb_5000" },
        { text: "10rb", callback_data: "nb_10000" },
        { text: "20rb", callback_data: "nb_20000" },
      ],
      [
        { text: "50rb", callback_data: "nb_50000" },
        { text: "100rb", callback_data: "nb_100000" },
        { text: "200rb", callback_data: "nb_200000" },
      ],
      [{ text: "✏️ Nominal lain", callback_data: "nb_custom" }],
    ]
  );
}

// ── Simpan nabung ─────────────────────────────────────────────────────────────
async function simpanNabung(chatId, userId, namaUser, jumlah, keterangan) {
  // Animasi loading
  bot.sendChatAction(chatId, "typing").catch(() => {});
  await loadingDots(chatId, "Menyimpan");

  const { error } = await supabase.from("transaksi").insert({
    nama: namaUser, telegram_id: userId, jumlah, keterangan, chat_id: chatId,
  });
  if (error) { await toast(chatId, "❌ Gagal menyimpan"); return renderHome(chatId, namaUser); }

  const { data: all } = await supabase.from("transaksi").select("jumlah,telegram_id").eq("chat_id", chatId);
  const totalBersama = all?.reduce((s, t) => s + t.jumlah, 0) || 0;
  const totalAku = all?.filter(t => t.telegram_id === userId).reduce((s, t) => s + t.jumlah, 0) || 0;
  const { data: tRow } = await supabase.from("target").select("jumlah").eq("chat_id", chatId).single();
  const target = tRow?.jumlah || 0;

  let targetLine = "";
  if (target > 0) {
    const pct = Math.min(100, Math.round((totalBersama / target) * 100));
    // Animasi progress bar ngisi
    await animateBar(chatId,
`✅ *BERHASIL DISIMPAN*
${sep}
👤 *${namaUser}* +${IDR(jumlah)}
🎯 Menuju target ${IDR(target)}`, pct);
    targetLine = `\n🎯 \`${barChart(pct)}\` *${pct}%*`;
    // Confetti kalau tercapai
    if (totalBersama >= target) {
      await bot.sendMessage(chatId, "🎉").catch(() => {});
    }
  }

  await showMain(chatId,
`✅ *BERHASIL DISIMPAN*
${sep}
👤 *${namaUser}*
💵 +${IDR(jumlah)}${keterangan ? `\n📝 _${keterangan}_` : ""}
${sep}
💼 Tabunganmu › *${IDR(totalAku)}*
🏦 Total bersama › *${IDR(totalBersama)}*${targetLine}`,
    [[{ text: "💰 Nabung lagi", callback_data: "go_nabung" }, { text: "🏠 Menu", callback_data: "go_home" }]]
  );
}

// ── Render: Saldo ─────────────────────────────────────────────────────────────
async function renderSaldo(chatId) {
  const { data } = await supabase.from("transaksi").select("nama,jumlah").eq("chat_id", chatId);
  if (!data?.length) {
    return showMain(chatId, `📊 *SALDO*\n${sep}\n📭 _Belum ada tabungan_\nMulai dengan tombol Nabung!`,
      [[{ text: "💰 Mulai Nabung", callback_data: "go_nabung" }]]);
  }
  const perOrang = {};
  data.forEach(t => { perOrang[t.nama] = (perOrang[t.nama] || 0) + t.jumlah; });
  const total = data.reduce((s, t) => s + t.jumlah, 0);
  const sorted = Object.entries(perOrang).sort((a, b) => b[1] - a[1]);

  const baris = sorted.map(([n, j]) => {
    const pct = Math.round((j / total) * 100);
    return `👤 *${n}*  _${pct}%_\n\`${barChart(pct, 14)}\`\n💰 *${IDR(j)}*`;
  }).join(`\n${sep}\n`);

  const { data: tRow } = await supabase.from("target").select("jumlah").eq("chat_id", chatId).single();
  const target = tRow?.jumlah || 0;
  let targetSection = "";
  if (target > 0) {
    const pct = Math.min(100, Math.round((total / target) * 100));
    const sisa = Math.max(0, target - total);
    targetSection = `\n${sep}\n🎯 *Target*  ${IDR(target)}\n\`${barChart(pct, 14)}\`  *${pct}%*\n💸 Sisa  *${IDR(sisa)}*`;
  }

  await showMain(chatId,
`📊 *SALDO TABUNGAN*
${sep}
${baris}
${sep}
🏦 *Total  ${IDR(total)}*${targetSection}`
  );
}

// ── Render: Riwayat ───────────────────────────────────────────────────────────
async function renderRiwayat(chatId) {
  const { data } = await supabase.from("transaksi").select("*").eq("chat_id", chatId)
    .order("created_at", { ascending: false }).limit(8);
  if (!data?.length) {
    return showMain(chatId, `📋 *RIWAYAT*\n${sep}\n📭 _Belum ada transaksi_`,
      [[{ text: "💰 Mulai Nabung", callback_data: "go_nabung" }]]);
  }
  const baris = data.map((t, i) => {
    const ket = t.keterangan ? `\n   📝 _${t.keterangan}_` : "";
    const no = String(i + 1).padStart(2, " ");
    return `\`${no}\` *${t.nama}*\n   💵 *${IDR(t.jumlah)}*${ket}\n   🗓 _${fmtDate(t.created_at)}_`;
  }).join(`\n${sep}\n`);

  await showMain(chatId, `📋 *RIWAYAT*\n_8 transaksi terakhir_\n${sep}\n${baris}`);
}

// ── Render: Statistik ─────────────────────────────────────────────────────────
async function renderStatistik(chatId) {
  const { data } = await supabase.from("transaksi").select("*").eq("chat_id", chatId)
    .order("created_at", { ascending: true });
  if (!data?.length) {
    return showMain(chatId, `📈 *STATISTIK*\n${sep}\n📭 _Belum ada data_`,
      [[{ text: "💰 Mulai Nabung", callback_data: "go_nabung" }]]);
  }

  const total = data.reduce((s, t) => s + t.jumlah, 0);
  const perOrang = {};
  data.forEach(t => {
    if (!perOrang[t.nama]) perOrang[t.nama] = { total: 0, count: 0, max: 0, min: Infinity };
    const p = perOrang[t.nama];
    p.total += t.jumlah; p.count++; p.max = Math.max(p.max, t.jumlah); p.min = Math.min(p.min, t.jumlah);
  });
  const hari = Math.max(1, Math.ceil((new Date() - new Date(data[0].created_at)) / 86400000));
  const avgHarian = Math.round(total / hari);

  const statOrang = Object.entries(perOrang).map(([n, s]) => {
    const pct = Math.round((s.total / total) * 100);
    const avg = Math.round(s.total / s.count);
    return [
      `👤 *${n}*  _${pct}%_`,
      `\`${barChart(pct, 10)}\``,
      `💰 *${IDR(s.total)}*  ·  ${s.count}x nabung`,
      `📈 Terbesar   *${IDR(s.max)}*`,
      `📉 Terkecil    *${IDR(s.min)}*`,
      `📊 Rata-rata  *${IDR(avg)}*`,
    ].join("\n");
  }).join(`\n${sep}\n`);

  const { data: tRow } = await supabase.from("target").select("jumlah").eq("chat_id", chatId).single();
  const target = tRow?.jumlah || 0;
  let tStr = "";
  if (target > 0) {
    const sisa = Math.max(0, target - total);
    const est = sisa > 0 ? Math.ceil(sisa / avgHarian) : 0;
    const pct = Math.min(100, Math.round((total / target) * 100));
    tStr = `\n${sep}\n🎯 *Target*  ${IDR(target)}\n\`${barChart(pct, 12)}\`  *${pct}%*\n⏳ ${est > 0 ? `Estimasi *${est} hari* lagi` : "*Tercapai! 🎉*"}`;
  }

  await showMain(chatId,
`📈 *STATISTIK*
_Sejak ${fmtDate(data[0].created_at)}_
${sep}
${statOrang}
${sep}
🏦 *Total  ${IDR(total)}*
📅 Hari menabung   *${hari} hari*
📆 Rata-rata/hari  *${IDR(avgHarian)}*
🔢 Total transaksi  *${data.length}x*${tStr}`
  );
}

// ── Render: Target ────────────────────────────────────────────────────────────
async function renderTarget(chatId) {
  const { data: tRow } = await supabase.from("target").select("jumlah").eq("chat_id", chatId).single();
  const { data: all } = await supabase.from("transaksi").select("jumlah").eq("chat_id", chatId);
  const total = all?.reduce((s, t) => s + t.jumlah, 0) || 0;

  if (!tRow) {
    return showMain(chatId,
`🎯 *TARGET*
${sep}
_Belum ada target_
Ketik: \`target 1jt\` atau \`target 1000000\``);
  }
  const pct = Math.min(100, Math.round((total / tRow.jumlah) * 100));
  const sisa = Math.max(0, tRow.jumlah - total);
  await showMain(chatId,
`🎯 *TARGET TABUNGAN*
${sep}
Target › *${IDR(tRow.jumlah)}*
Terkumpul › *${IDR(total)}*

\`${barChart(pct, 16)}\`
*${pct}%*
${sisa > 0 ? `💸 Sisa *${IDR(sisa)}*` : "🎉 *Target tercapai!*"}
${sep}
_Ubah: ketik_ \`target [jumlah]\``);
}

// ── Render: Hapus ─────────────────────────────────────────────────────────────
async function renderHapus(chatId, userId) {
  const { data } = await supabase.from("transaksi").select("*").eq("chat_id", chatId)
    .eq("telegram_id", userId).order("created_at", { ascending: false }).limit(1);
  if (!data?.length) {
    return showMain(chatId, `🗑 *HAPUS*\n${sep}\n_Tidak ada transaksimu untuk dihapus_`);
  }
  const t = data[0];
  await showMain(chatId,
`🗑 *HAPUS TRANSAKSI?*
${sep}
👤 *${t.nama}*
💵 ${IDR(t.jumlah)}${t.keterangan ? `\n📝 _${t.keterangan}_` : ""}
🗓 ${fmtDate(t.created_at)}
${sep}
_Yakin mau hapus?_`,
    [[
      { text: "✅ Ya, hapus", callback_data: `hapus_ok_${t.id}` },
      { text: "↩️ Batal", callback_data: "go_home" },
    ]]
  );
}

// ── Command handlers (dulunya bot.onText) ────────────────────────────────────
async function handleNabungCommand(msg, m) {
  if (!allowed(msg.chat.id)) return;
  bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
  const arg = m && m[1];
  if (arg) {
    const jumlah = parseAmount(arg);
    if (!isNaN(jumlah) && jumlah > 0) {
      await setWaiting(msg.from.id, { chatId: msg.chat.id, nama: nama(msg), step: "keterangan", jumlah });
      return showMain(msg.chat.id,
`💰 *NABUNG*\n${sep}\nNominal: *${IDR(jumlah)}*\n${sep}\n📝 _Ketik keterangan, atau Skip_`,
        [[{ text: "⏭ Skip & Simpan", callback_data: `ket_skip_${jumlah}` }, { text: "↩️ Batal", callback_data: "go_home" }]]);
    }
  }
  return renderNabungPicker(msg.chat.id, msg.from.id, nama(msg));
}
async function handleSaldoCommand(msg) { if (allowed(msg.chat.id)) return renderSaldo(msg.chat.id); }
async function handleRiwayatCommand(msg) { if (allowed(msg.chat.id)) return renderRiwayat(msg.chat.id); }
async function handleStatistikCommand(msg) { if (allowed(msg.chat.id)) return renderStatistik(msg.chat.id); }
async function handleTargetCommand(msg, m) {
  if (!allowed(msg.chat.id)) return;
  bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
  const arg = m && m[1];
  if (arg) {
    const jumlah = parseAmount(arg);
    if (!isNaN(jumlah) && jumlah > 0) {
      await supabase.from("target").upsert({ chat_id: msg.chat.id, jumlah }, { onConflict: "chat_id" });
    }
  }
  return renderTarget(msg.chat.id);
}
async function handleHapusCommand(msg) { if (allowed(msg.chat.id)) return renderHapus(msg.chat.id, msg.from.id); }
async function handleHelpCommand(msg) { if (allowed(msg.chat.id)) return renderHome(msg.chat.id, nama(msg)); }

// ── Tangkap teks (shortcut + input nominal/keterangan) ────────────────────────
async function handleGenericMessage(msg) {
  if (!msg.text || !allowed(msg.chat.id)) return;
  const text = msg.text.trim();
  const lower = text.toLowerCase();
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const namaUser = nama(msg);

  if (text.startsWith("/")) return;

  // Hapus pesan user biar chat bersih (cuma 1 kartu utama)
  const cleanup = () => bot.deleteMessage(chatId, msg.message_id).catch(() => {});

  // ── State waiting
  const st = await getWaiting(userId);
  if (st) {
    if (st.step === "nominal_custom") {
      const jumlah = parseAmount(lower);
      cleanup();
      if (isNaN(jumlah) || jumlah <= 0) { await toast(chatId, "❌ Nominal tidak valid"); return; }
      await setWaiting(userId, { ...st, step: "keterangan", jumlah });
      return showMain(chatId,
`💰 *NABUNG*
${sep}
Nominal: *${IDR(jumlah)}*
${sep}
📝 _Ketik keterangan, atau Skip_`,
        [[
          { text: "⏭ Skip & Simpan", callback_data: `ket_skip_${jumlah}` },
          { text: "↩️ Batal", callback_data: "go_home" },
        ]]
      );
    }

    if (st.step === "keterangan") {
      cleanup();
      const jumlah = st.jumlah;
      await clearWaiting(userId);
      return simpanNabung(chatId, userId, st.nama, jumlah, text);
    }
  }

  // ── Set target via teks
  const tMatch = lower.match(/^(?:target|t)\s+([\d\.,]+(?:rb|ribu|jt|juta)?)/i);
  if (tMatch) {
    const jumlah = parseAmount(tMatch[1]);
    cleanup();
    if (isNaN(jumlah) || jumlah <= 0) { await toast(chatId, "❌ Contoh: target 1jt"); return; }
    await supabase.from("target").upsert({ chat_id: chatId, jumlah }, { onConflict: "chat_id" });
    await toast(chatId, `✅ Target di-set ${IDR(jumlah)}`);
    return renderTarget(chatId);
  }

  // ── Langsung angka → nabung
  if (/^[\d\.,]+\s*(rb|ribu|jt|juta)?$/i.test(lower)) {
    const jumlah = parseAmount(lower);
    if (!isNaN(jumlah) && jumlah > 0) {
      cleanup();
      await setWaiting(userId, { chatId, nama: namaUser, step: "keterangan", jumlah });
      return showMain(chatId,
`💰 *NABUNG*
${sep}
Nominal: *${IDR(jumlah)}*
${sep}
📝 _Ketik keterangan, atau Skip_`,
        [[
          { text: "⏭ Skip & Simpan", callback_data: `ket_skip_${jumlah}` },
          { text: "↩️ Batal", callback_data: "go_home" },
        ]]
      );
    }
  }

  // ── nabung + angka dalam 1 pesan
  const nMatch = lower.match(/(?:nabung|n)\s+([\d\.,]+(?:rb|ribu|jt|juta)?)/i);
  if (nMatch) {
    const jumlah = parseAmount(nMatch[1]);
    if (!isNaN(jumlah) && jumlah > 0) {
      cleanup();
      await setWaiting(userId, { chatId, nama: namaUser, step: "keterangan", jumlah });
      return showMain(chatId,
`💰 *NABUNG*
${sep}
Nominal: *${IDR(jumlah)}*
${sep}
📝 _Ketik keterangan, atau Skip_`,
        [[
          { text: "⏭ Skip & Simpan", callback_data: `ket_skip_${jumlah}` },
          { text: "↩️ Batal", callback_data: "go_home" },
        ]]
      );
    }
  }

  // ── Shortcut menu (teks)
  const map = {
    nabung: "go_nabung", n: "go_nabung",
    saldo: "go_saldo", s: "go_saldo",
    riwayat: "go_riwayat", r: "go_riwayat",
    statistik: "go_statistik", stat: "go_statistik", stats: "go_statistik",
    target: "go_target",
    hapus: "go_hapus",
    menu: "go_home", home: "go_home",
  };
  if (map[lower]) {
    cleanup();
    const action = map[lower];
    if (action === "go_nabung") return renderNabungPicker(chatId, userId, namaUser);
    if (action === "go_saldo") return renderSaldo(chatId);
    if (action === "go_riwayat") return renderRiwayat(chatId);
    if (action === "go_statistik") return renderStatistik(chatId);
    if (action === "go_target") return renderTarget(chatId);
    if (action === "go_hapus") return renderHapus(chatId, userId);
    if (action === "go_home") return renderHome(chatId, namaUser);
  }
}

// ── Photo OCR ─────────────────────────────────────────────────────────────────
// Download file dari Telegram sebagai base64
async function getTelegramFileBase64(fileId) {
  const fileInfo = await bot.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileInfo.file_path}`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// Kirim ke model vision (lewat OpenRouter, model gratis) buat baca nominal
async function extractNominalFromImage(base64, mimeType = "image/jpeg") {
  if (!OPENROUTER_KEY) throw new Error("OPENROUTER_KEY belum diset");

  const prompt = `Kamu membantu tracking tabungan. Lihat gambar ini dan ekstrak nominal uang yang ditabung/ditransfer.

Aturan:
- Cari angka nominal transfer, pembayaran, atau tabungan
- Abaikan biaya admin, saldo sebelumnya, atau saldo akhir
- Kembalikan HANYA angka bulat tanpa titik/koma/Rp, contoh: 50000
- Kalau ada beberapa nominal, ambil yang paling relevan (nominal transfer utama)
- Kalau tidak ada nominal yang jelas, kembalikan: TIDAK_DITEMUKAN

Jawab hanya dengan angka atau TIDAK_DITEMUKAN.`;

  const body = JSON.stringify({
    model: OPENROUTER_MODEL,
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
      }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            return reject(new Error(`OpenRouter API error ${json.error.code}: ${json.error.message}`));
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
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Handler foto masuk
async function handlePhoto(msg) {
  if (!allowed(msg.chat.id)) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const namaUser = nama(msg);

  // Ambil foto resolusi terbesar
  const photo = msg.photo[msg.photo.length - 1];

  // Hapus pesan foto user biar bersih
  bot.deleteMessage(chatId, msg.message_id).catch(() => {});

  // Tampilkan loading
  await showMain(chatId,
`📸 *SCAN STRUK*
${sep}
⏳ _Membaca gambar..._`);

  try {
    const base64 = await getTelegramFileBase64(photo.file_id);

    await editPlain(chatId, `📸 _Menganalisis nominal..._`);

    const result = await extractNominalFromImage(base64);
    const jumlah = parseAmount(result);

    if (result === "TIDAK_DITEMUKAN" || isNaN(jumlah)) {
      return showMain(chatId,
`📸 *SCAN STRUK*
${sep}
❌ *Nominal tidak terdeteksi*

Coba foto yang lebih jelas, atau input manual:`,
        [[{ text: "💰 Input Manual", callback_data: "go_nabung" }, { text: "🏠 Menu", callback_data: "go_home" }]]
,
        true
      );
    }

    // Set ke state keterangan, siap konfirmasi
    await setWaiting(userId, { chatId, nama: namaUser, step: "keterangan", jumlah });

    await showMain(chatId,
`📸 *SCAN BERHASIL*
${sep}
✅ Nominal terdeteksi:
💵 *${IDR(jumlah)}*
${sep}
📝 _Tambahkan keterangan, atau langsung simpan_`,
      [[
        { text: "⏭ Skip & Simpan", callback_data: `ket_skip_${jumlah}` },
        { text: "↩️ Batal", callback_data: "go_home" },
      ]]
    );

  } catch (err) {
    console.error("Photo OCR error:", err);
    await showMain(chatId,
`📸 *SCAN STRUK*
${sep}
❌ Gagal membaca gambar
_Coba lagi atau input manual_`,
      [[{ text: "💰 Input Manual", callback_data: "go_nabung" }, { text: "🏠 Menu", callback_data: "go_home" }]]
,
      true
    );
  }
}

// Handler dokumen (foto dikirim sebagai file)
async function handleDocument(msg) {
  if (!allowed(msg.chat.id)) return;
  const doc = msg.document;
  if (!doc.mime_type?.startsWith("image/")) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const namaUser = nama(msg);

  bot.deleteMessage(chatId, msg.message_id).catch(() => {});

  await showMain(chatId, `📸 *SCAN STRUK*\n${sep}\n⏳ _Membaca gambar..._`);

  try {
    const base64 = await getTelegramFileBase64(doc.file_id);
    await editPlain(chatId, `📸 _Menganalisis nominal..._`);
    const result = await extractNominalFromImage(base64, doc.mime_type);
    const jumlah = parseAmount(result);

    if (result === "TIDAK_DITEMUKAN" || isNaN(jumlah)) {
      return showMain(chatId,
`📸 *SCAN STRUK*\n${sep}\n❌ *Nominal tidak terdeteksi*\nCoba foto lebih jelas, atau input manual:`,
        [[{ text: "💰 Input Manual", callback_data: "go_nabung" }, { text: "🏠 Menu", callback_data: "go_home" }]]
      );
    }
    await setWaiting(userId, { chatId, nama: namaUser, step: "keterangan", jumlah });

    await showMain(chatId,
`📸 *SCAN BERHASIL*\n${sep}\n✅ Nominal terdeteksi:\n💵 *${IDR(jumlah)}*\n${sep}\n📝 _Tambahkan keterangan, atau langsung simpan_`,
      [[
        { text: "⏭ Skip & Simpan", callback_data: `ket_skip_${jumlah}` },
        { text: "↩️ Batal", callback_data: "go_home" },
      ]]
,
      true
    );
  } catch (err) {
    console.error("Doc OCR error:", err);
    await showMain(chatId, `📸 *SCAN STRUK*\n${sep}\n❌ Gagal membaca gambar`,
      [[{ text: "💰 Input Manual", callback_data: "go_nabung" }]],
      true
    );
  }
}

// ── Dispatcher tunggal (dipanggil dari api/webhook.js, ter-await penuh) ──────
async function handleUpdate(update) {
  try {
    if (update.callback_query) return await handleCallbackQuery(update.callback_query);

    const msg = update.message;
    if (!msg) return;

    if (msg.photo) return await handlePhoto(msg);
    if (msg.document) return await handleDocument(msg);

    if (msg.text) {
      if (/^\/start\b/.test(msg.text)) return await handleStart(msg);
      if (/^\/nabung\b/.test(msg.text)) return await handleNabungCommand(msg, msg.text.match(/\/nabung(?:\s+(.+))?/));
      if (/^\/saldo\b/.test(msg.text)) return await handleSaldoCommand(msg);
      if (/^\/riwayat\b/.test(msg.text)) return await handleRiwayatCommand(msg);
      if (/^\/statistik\b/.test(msg.text)) return await handleStatistikCommand(msg);
      if (/^\/target\b/.test(msg.text)) return await handleTargetCommand(msg, msg.text.match(/\/target(?:\s+(.+))?/));
      if (/^\/hapus\b/.test(msg.text)) return await handleHapusCommand(msg);
      if (/^\/help\b/.test(msg.text)) return await handleHelpCommand(msg);
      if (msg.text.startsWith("/")) return; // command lain yang belum dikenal — diamkan
      return await handleGenericMessage(msg);
    }
  } catch (err) {
    console.error("handleUpdate error:", err);
  }
}

module.exports = { bot, handleUpdate };
