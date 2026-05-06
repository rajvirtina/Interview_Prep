import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

const isDev = process.env.NODE_ENV !== "production";

if (!process.env.GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY is not set. Copy backend/.env.example to backend/.env and fill in your key.");
  process.exit(1);
}

const DEFAULT_GEMINI_MODELS = [
  "gemini-2.0-flash",
  "gemini-2.5-flash",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash-lite",
];

function getGeminiModels() {
  const configured = [
    process.env.GEMINI_MODEL,
    ...(process.env.GEMINI_FALLBACK_MODELS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ].filter(Boolean);

  return [...new Set(configured.length > 0 ? configured : DEFAULT_GEMINI_MODELS)];
}

function isTransientGeminiError(status, message) {
  const text = String(message || "").toLowerCase();
  return (
    status === 429 ||
    status === 500 ||
    status === 503 ||
    text.includes("high demand") ||
    text.includes("try again later") ||
    text.includes("rate limit") ||
    text.includes("resource exhausted")
  );
}

function isQuotaExceededGeminiError(status, message) {
  const text = String(message || "").toLowerCase();
  return (
    status === 429 &&
    (text.includes("quota exceeded") ||
      text.includes("billing details") ||
      text.includes("free_tier_requests") ||
      text.includes("rate-limits"))
  );
}

function extractRetryAfterMs(message) {
  const text = String(message || "");
  const match = text.match(/retry\s+in\s+([0-9]+(?:\.[0-9]+)?)s/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.ceil(seconds * 1000);
}

async function callGeminiModel({ apiKey, model, system, contents, maxTokens }) {
  const controller = new AbortController();
  const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS || 45000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: String(system) }],
          },
          contents,
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: Number(maxTokens || 2000),
          },
        }),
        signal: controller.signal,
      }
    );

    const raw = await upstream.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (_) {
      const snippet = String(raw || "").slice(0, 240);
      data = {
        error: {
          message: `Non-JSON response from Gemini upstream (status ${upstream.status}): ${snippet}`,
        },
      };
    }
    return {
      ok: upstream.ok,
      status: upstream.status,
      data,
      model,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      return {
        ok: false,
        status: 504,
        data: { error: { message: `Gemini request timed out for model ${model}` } },
        model,
      };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildTokenBudgets(maxTokens) {
  const base = Number(maxTokens || 4000);
  return [base];
}

const app = express();
const port = Number(process.env.PORT || 8787);

const allowList = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

if (allowList.length === 0) {
  console.warn("⚠️  CORS_ORIGIN is not set — all origins are allowed. Do NOT use in production.");
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowList.length === 0 || allowList.includes(origin)) return callback(null, true);
      if (/^https?:\/\/localhost(:[0-9]+)?$/.test(origin)) return callback(null, true);
      return callback(new Error("CORS blocked"));
    },
  })
);

app.use(express.json({ limit: "1mb" }));

app.use("/api/messages",
  rateLimit({ windowMs: 60_000, max: 20, message: { error: "Too many requests, please try again later." } })
);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/messages", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "GEMINI_API_KEY missing in backend environment" });
    }

    const { messages, system, maxTokens } = req.body || {};
    if (!Array.isArray(messages) || !system) {
      return res.status(400).json({ error: "Invalid payload: messages and system are required" });
    }

    const models = getGeminiModels();

    const contents = messages.map((m) => ({
      role: m?.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m?.content || "") }],
    }));

    let lastFailure = null;
    let data = null;
    let successMeta = null;
    const tokenBudgets = buildTokenBudgets(maxTokens);

    for (const model of models) {
      for (const budget of tokenBudgets) {
        const result = await callGeminiModel({
          apiKey,
          model,
          system,
          contents,
          maxTokens: budget,
        });

        if (result.ok) {
          data = result.data;
          successMeta = { model, budget };
          lastFailure = null;
          break;
        }

        const message = result?.data?.error?.message || `Upstream error ${result.status}`;
        lastFailure = { status: result.status, message, model, budget };
        if (isQuotaExceededGeminiError(result.status, message)) break;
        if (!isTransientGeminiError(result.status, message)) break;
      }

      if (data) break;
      if (lastFailure && !isTransientGeminiError(lastFailure.status, lastFailure.message)) break;
    }

    if (!data) {
      const retryAfterMs = extractRetryAfterMs(lastFailure?.message || "");
      const quotaExceeded = isQuotaExceededGeminiError(
        lastFailure?.status,
        lastFailure?.message
      );
      return res.status(lastFailure?.status || 502).json({
        error: lastFailure
          ? `${lastFailure.message} (model: ${lastFailure.model})`
          : "Gemini request failed",
        code: quotaExceeded ? "quota_exceeded" : "upstream_error",
        retryAfterMs,
      });
    }

    const text = data?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text || "")
      .join("");
    if (!text) {
      return res.status(502).json({ error: "No text content returned from AI" });
    }

    if (isDev) {
      const textPreview = text.length > 500 ? text.substring(0, 500) + "..." : text;
      console.log("[DEBUG] Gemini response preview:", {
        text_length: text.length,
        preview: textPreview,
        candidate_count: data?.candidates?.length || 0,
        stop_reason: data?.candidates?.[0]?.finishReason || "unknown",
        model_used: successMeta?.model || "unknown",
        token_budget_used: successMeta?.budget || Number(maxTokens || 0),
      });
    }

    return res.json({ text });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Unexpected backend error" });
  }
});

app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});
