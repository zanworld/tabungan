// HANYA buat testing lokal. Production (Vercel) pakai api/webhook.js,
// file ini nggak ke-deploy ke sana sama sekali.
//
// Jalanin: npm run dev   (atau npm run dev:watch buat auto-restart)

const { bot, handleUpdate } = require("./lib/bot");

bot.on("polling_error", (err) => console.error("Polling error:", err.message));

// Sengaja CUMA bind "message" + "callback_query". Library ini nembak event
// "photo"/"document" BARENGAN dengan "message" (bukan gantiin) — kalau
// semuanya di-bind ke handleUpdate, foto/dokumen bakal diproses dobel.
// handleUpdate() sendiri yang nentuin itu foto, dokumen, atau teks biasa
// dari isi message-nya, persis kayak yang dipakai di webhook production.
bot.on("message", (msg) => handleUpdate({ message: msg }).catch(console.error));
bot.on("callback_query", (q) => handleUpdate({ callback_query: q }).catch(console.error));

bot.startPolling();
console.log("🤖 Bot jalan LOKAL (mode polling, cuma buat testing). Production tetap pakai webhook di Vercel.");
