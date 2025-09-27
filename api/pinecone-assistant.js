Looking at GPT-5's analysis, the diagnosis makes sense. The build log shows:
- ✅ Dependencies installed (20 packages including form-data)
- ✅ Build successful 
- ❌ Runtime "fetch failed" error persists

GPT-5's suggestion to use `Readable.from([content])` instead of `Buffer.from(content)` is actually a solid fix. In Vercel's serverless environment, streaming can be more reliable than direct Buffer usage with form-data.

Here's the complete corrected `api/pinecone-assistant.js` with the streaming fix:

```javascript
import FormData from "form-data";
import { Readable } from "stream";

const API_VERSION = process.env.PINECONE_API_VERSION || "2025-01";
const HOST_CACHE_TTL_MS = 5 * 60 * 1000;
const hostCache = new Map();

export default async function handler(req, res) {
  const allowed = (process.env.ALLOWED_ORIGINS || "https://chatgpt.com").split(",");
  const origin = req.headers.origin;
  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Origin",
    allowed.includes(origin) ? origin : allowed[0] || "*"
  );
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  const AUTH_TOKEN = process.env.MONEYPENNY_AUTH_TOKEN;
  if (AUTH_TOKEN && req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ success: false, error: "Invalid JSON body" });
    }
  }

  const { action, assistant_name, assistant_host, data = {}, assistant_id } = body || {};
  const name = assistant_name || assistant_id;
  if (!name) return res.status(400).json({ success: false, error: "assistant_name is required" });

  try {
    const base = assistant_host ? normalizeAssistantBase(assistant_host) : await getAssistantBase(name);
    let out;

    switch (action) {
      case "chat": {
        out = await chatWithAssistant(base, name, data);
        return res.status(200).json({ success: true, type: "chat", data: out });
      }
      case "store": {
        out = await storeMemory(base, name, data);
        return res.status(200).json({ success: true, type: "store", data: out });
      }
      case "search": {
        out = await searchMemories(base, name, data);
        return res.status(200).json({ success: true, type: "search", data: out });
      }
      default:
        return res.status(400).json({ success: false, error: "Invalid action" });
    }
  } catch (err) {
    console.error("Pinecone Assistant API error:", err);
    const { status = 500, message = "Unknown error", details } = normalizeError(err);
    return res.status(status).json({ success: false, error: message, details });
  }
}

function normalizeAssistantBase(host) {
  const clean = host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${clean}/assistant`;
}

async function getAssistantBase(assistantName) {
  const now = Date.now();
  const cached = hostCache.get(assistantName);
  if (cached && cached.expiresAt > now) return `https://${cached.host}/assistant`;

  const url = `https://api.pinecone.io/assistant/assistants/${encodeURIComponent(assistantName)}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "X-Pinecone-API-Version": API_VERSION,
    },
  });
  if (!resp.ok) throw enrich(resp, "Failed to describe assistant (host discovery)");
  const data = await resp.json();
  if (!data.host) throw new Error("Assistant response missing 'host'");
  hostCache.set(assistantName, { host: data.host, expiresAt: now + HOST_CACHE_TTL_MS });
  return `https://${data.host}/assistant`;
}

async function chatWithAssistant(base, assistantName, {
  message,
  context = [],
  model = "gpt-4o",
  filter,
  json_response,
  stream = false,
} = {}) {
  const body = {
    messages: [
      ...context,
      message ? { role: "user", content: message } : null,
    ].filter(Boolean),
    model,
    stream,
    ...(filter ? { filter } : {}),
    ...(json_response ? { json_response: true } : {}),
    include_highlights: true,
  };

  const resp = await doFetch(`${base}/chat/${encodeURIComponent(assistantName)}`, {
    method: "POST",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "Content-Type": "application/json",
      "X-Pinecone-API-Version": API_VERSION,
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  return {
    response: data.message?.content ?? "",
    citations: data.citations ?? [],
    usage: data.usage ?? {},
    model: data.model,
  };
}

async function storeMemory(base, assistantName, { content, metadata = {}, multimodal } = {}) {
  if (!content) throw new Error("store: 'content' is required");

  const metaOut = {
    ...metadata,
    stored_at: new Date().toISOString(),
    type: metadata?.type || "memory",
  };

  const qs = new URLSearchParams();
  if (Object.keys(metaOut).length) {
    qs.set("metadata", JSON.stringify(metaOut));
  }
  if (typeof multimodal === "boolean") {
    qs.set("multimodal", String(multimodal));
  }

  // Use form-data with streaming for reliability in serverless
  const form = new FormData();
  form.append("file", Readable.from([content]), {
    filename: `memory_${Date.now()}.txt`,
    contentType: "text/plain",
  });

  const url = `${base}/files/${encodeURIComponent(assistantName)}${qs.toString() ? "?" + qs.toString() : ""}`;

  const resp = await doFetch(url, {
    method: "POST",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "X-Pinecone-API-Version": API_VERSION,
      ...form.getHeaders(),
    },
    body: form,
  });

  const data = await resp.json();
  return {
    file_id: data.id,
    file_name: data.name,
    status: data.status,
    metadata: data.metadata,
    timestamp: new Date().toISOString(),
  };
}

async function searchMemories(base, assistantName, { query, messages, top_k, filter } = {}) {
  const body =
    messages?.length ? { messages } :
    query ? { query } :
    null;
  if (!body) throw new Error("search: provide 'query' or 'messages'");

  if (filter) body.filter = filter;
  if (top_k) body.top_k = top_k;

  const resp = await doFetch(`${base}/chat/${encodeURIComponent(assistantName)}/context`, {
    method: "POST",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "Content-Type": "application/json",
      "X-Pinecone-API-Version": API_VERSION,
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  return {
    snippets: data.snippets ?? [],
    usage: data.usage ?? {},
    id: data.id,
  };
}

async function doFetch(url, opts, retries = 2) {
  const resp = await fetch(url, opts);
  if (resp.status === 429 && retries > 0) {
    await new Promise((r) => setTimeout(r, (3 - retries) * 500));
    return doFetch(url, opts, retries - 1);
  }
  if (!resp.ok) throw enrich(resp);
  return resp;
}

function normalizeError(err) {
  if (err?.__http) return { status: err.status, message: err.message, details: err.details };
  return { message: err?.message || String(err) };
}

function enrich(resp, prefix = "Request failed") {
  const e = new Error(`${prefix}: ${resp.status} ${resp.statusText}`);
  e.__http = true;
  e.status = resp.status;
  e.details = { url: resp.url };
  return e;
}
```

The key changes:
1. Added `import { Readable } from "stream";` at line 2
2. Changed line 138 to use `Readable.from([content])` instead of `Buffer.from(content)`

This creates a proper Node stream that form-data can handle more reliably in Vercel's serverless environment. Push this change and it should resolve the "fetch failed" error.
