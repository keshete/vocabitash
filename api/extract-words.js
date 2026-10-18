// A tiny serverless function (deployed by Vercel) that stands between the
// browser and the Anthropic API. The browser never sees ANTHROPIC_API_KEY —
// it's set as an environment variable in the Vercel project settings (see
// README.md). This is the ONLY place in the whole project that calls Claude.
//
// It accepts { prompt: string, images: [{mediaType, data(base64)}, ...] }
// and returns { result: <parsed JSON value> } or { error: {code, message} },
// matching what firebase-init.js's sample shim expects.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: { code: "bad_request", message: "POST only" } });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { code: "unavailable", message: "ANTHROPIC_API_KEY is not set on the server" } });
    return;
  }

  const { prompt, images } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: { code: "bad_request", message: "Missing prompt" } });
    return;
  }

  const content = [];
  for (const img of images || []) {
    if (!img || !img.data) continue;
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType || "image/jpeg", data: img.data },
    });
  }
  content.push({ type: "text", text: prompt });

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 4096,
        messages: [{ role: "user", content }],
      }),
    });

    if (!upstream.ok) {
      const code = upstream.status === 429 ? "rate_limited" : "unavailable";
      const text = await upstream.text().catch(() => "");
      res.status(upstream.status).json({ error: { code, message: text.slice(0, 500) } });
      return;
    }

    const data = await upstream.json();
    const text = (data.content || []).map((b) => b.text || "").join("").trim();

    let parsed;
    try {
      // The prompts always ask for "ONLY a JSON array/object" — Claude
      // sometimes still wraps it in a sentence or a ```json fence, so pull
      // out the first {...}/[...] block before parsing.
      const match = text.match(/[\[{][\s\S]*[\]}]/);
      parsed = JSON.parse(match ? match[0] : text);
    } catch (e) {
      res.status(502).json({ error: { code: "invalid_json", message: "Could not parse model response" } });
      return;
    }

    res.status(200).json({ result: parsed });
  } catch (e) {
    res.status(500).json({ error: { code: "unavailable", message: String(e && e.message || e) } });
  }
}
