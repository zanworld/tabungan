const { handleUpdate } = require("../lib/bot");

module.exports = async (req, res) => {
  // Telegram will POST every update here. A GET is just for sanity-checking
  // that the deployment is live (e.g. opening the URL in a browser).
  if (req.method !== "POST") {
    res.status(200).json({ ok: true, info: "Tabungan bot webhook is running." });
    return;
  }

  try {
    // IMPORTANT: this is awaited all the way through (unlike the old
    // bot.processUpdate(), which fires event-emitter listeners without
    // waiting for them). On serverless, the function can be frozen the
    // moment we respond — if we responded before the async work finished,
    // messages could silently never get sent.
    await handleUpdate(req.body);
  } catch (err) {
    console.error("Webhook error:", err);
    // Still answer 200 so Telegram doesn't aggressively retry the same
    // update forever; the error is already logged above.
  }

  res.status(200).json({ ok: true });
};
