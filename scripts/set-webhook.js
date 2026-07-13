// Jalankan SEKALI setelah deploy ke Vercel, buat kasih tau Telegram
// ke mana harus ngirim update (webhook URL). Nggak perlu dijalanin lagi
// kecuali URL Vercel-nya berubah.
//
// Cara pakai:
//   BOT_TOKEN=xxxx node scripts/set-webhook.js https://nama-app-kamu.vercel.app
//
// atau isi BOT_TOKEN di file .env lokal terus:
//   node -r dotenv/config scripts/set-webhook.js https://nama-app-kamu.vercel.app

const https = require("https");

const token = process.env.BOT_TOKEN;
const baseUrl = process.argv[2];

if (!token) {
  console.error("❌ BOT_TOKEN belum diset. Contoh: BOT_TOKEN=xxxx node scripts/set-webhook.js https://app-kamu.vercel.app");
  process.exit(1);
}
if (!baseUrl) {
  console.error("❌ URL Vercel belum dikasih. Contoh: node scripts/set-webhook.js https://app-kamu.vercel.app");
  process.exit(1);
}

const webhookUrl = `${baseUrl.replace(/\/$/, "")}/api/webhook`;
const apiUrl = `https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;

https.get(apiUrl, (res) => {
  let data = "";
  res.on("data", (c) => (data += c));
  res.on("end", () => {
    const json = JSON.parse(data);
    if (json.ok) {
      console.log(`✅ Webhook berhasil diset ke: ${webhookUrl}`);
    } else {
      console.error("❌ Gagal set webhook:", json);
    }
  });
}).on("error", (err) => {
  console.error("❌ Request error:", err);
});
