"use strict";

/**
 * Pinecone Assistant Connector — VS2
 *
 * What’s changed in VS2:
 * - FIX: deleteFile expects HTTP 200 (ack) and also tolerates 204 just in case.
 * - FIX: listFiles drops unsupported page_token; supports optional JSON `filter`.
 * - FIX: normalizeAssistantBase() always appends `/assistant` even when assistant_host is provided.
 * - Chat defaults: model=gpt-4o, temperature=0, include_highlights=false (can be overridden).
 * - listAssistants: removed page_token plumbing per spec notes.
 * - Error handling: improved enrich() + doFetch() with Retry-After backoff & body capture.
 * - File upload: intentionally deferred (store → 501).
 * - Streaming/SSE: deferred to next pass (no change in behavior).
 * - OpenAI-compatible chat: explicitly omitted.
 */

const API_VERSION = process.env.PINECONE_API_VERSION || "2025-04"; // env-overridable
const HOST_CACHE_TTL_MS = 5 * 60 * 1000;
const hostCache = new Map();

// Optional soft references (informational only)
const LIMITS = {
  upload_rpm: { starter: 5, standard: 20, enterprise: 300 },
  file_size_mb: {
    pdf: { starter: 10, standard: 100, enterprise: 100 },
    text_like: 10, // txt, md, json, docx
  },
};

module.exports = async function handler(req, res) {
  // ---- CORS ----
  const allowed = (process.env.ALLOWED_ORIGINS || "https://chatgpt.com").split(",");
  const origin = req.headers.origin;
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Origin", allowed.includes(origin) ? origin : allowed[0] || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  // ---- Optional bearer auth ----
  const AUTH_TOKEN = process.env.MONEYPENNY_AUTH_TOKEN;
  if (AUTH_TOKEN && req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  // ---- Parse body ----
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch {
      return res.status(400).json({ success: false, error: "Invalid JSON body" });
    }
  }
  const { action, assistant_name, assistant_host, data = {}, assistant_id } = body || {};
  const name = assistant_name || assistant_id;

  try {
    switch (action) {
      /* ----------------- Chat / Context ----------------- */

      // N.1: Reflective-organ mode (default): /chat
      case "chat": {
        if (!name) return res.status(400).json({ success: false, error: "assistant_name is required" });
        const base = assistant_host ? normalizeAssistantBase(assistant_host) : await getAssistantBase(name);

        // Defaults per VS2 decisions
        const {
          message,
          context = [],
          model = "gpt-4o",
          temperature = 0, // concise, no flourishes
          filter, // deferred; still pass-through if provided
          json_response,
          stream = false, // streaming support deferred to next pass (no SSE proxying yet)
          include_highlights = false, // default OFF
          context_options, // pass-through; do not hard-pin
          top_k,           // pass-through; do not hard-pin
        } = data || {};

        const payload = {
          messages: [
            ...context,
            message ? { role: "user", content: message } : null,
          ].filter(Boolean),
          model,
          temperature,
          stream,
          include_highlights,
          ...(filter ? { filter } : {}),
          ...(json_response ? { json_response: true } : {}),
          ...(context_options ? { context_options } : {}),
          ...(Number.isFinite(top_k) ? { top_k } : {}),
        };

        const resp = await doFetch(`${base}/chat/${encodeURIComponent(name)}`, {
          method: "POST",
          headers: {
            "Api-Key": process.env.PINECONE_API_KEY,
            "Content-Type": "application/json",
            "X-Pinecone-API-Version": API_VERSION,
          },
          body: JSON.stringify(payload),
        });

        const out = await resp.json();
        return res.status(200).json({
          success: true,
          type: "chat",
          data: {
            response: out.message?.content ?? "",
            citations: out.citations ?? [],
            context_snippets: out.context_snippets ?? [],
            usage: out.usage ?? {},
            model: out.model,
          },
        });
      }

      // N.2: Snippets mode (optional): /chat/.../context
      case "search": {
        if (!name) return res.status(400).json({ success: false, error: "assistant_name is required" });
        const base = assistant_host ? normalizeAssistantBase(assistant_host) : await getAssistantBase(name);

        const {
          query,
          messages,
          top_k, // variable; caller may set; best-practice defaults on server side
          filter, // deferred overall, but pass-through if provided
          context_options, // pass-through
        } = data || {};

        const payload = messages?.length ? { messages } : (query ? { query } : null);
        if (!payload) return res.status(400).json({ success: false, error: "search: provide 'query' or 'messages'" });
        if (filter) payload.filter = filter;
        if (Number.isFinite(top_k)) payload.top_k = top_k;
        if (context_options) payload.context_options = context_options;

        const resp = await doFetch(`${base}/chat/${encodeURIComponent(name)}/context`, {
          method: "POST",
          headers: {
            "Api-Key": process.env.PINECONE_API_KEY,
            "Content-Type": "application/json",
            "X-Pinecone-API-Version": API_VERSION,
          },
          body: JSON.stringify(payload),
        });

        const out = await resp.json();
        return res.status(200).json({
          success: true,
          type: "search",
          data: {
            snippets: out.snippets ?? [],
            usage: out.usage ?? {},
            id: out.id,
          },
        });
      }

      /* ----------------- Assistants (control plane) ----------------- */

      case "describeAssistant": {
        if (!name) return res.status(400).json({ success: false, error: "assistant_name is required" });
        const result = await describeAssistant(name);
        return res.status(200).json({ success: true, type: "describeAssistant", data: result });
      }

      case "listAssistants": {
        // VS2: per spec notes, remove page_token plumbing
        const result = await listAssistants();
        return res.status(200).json({ success: true, type: "listAssistants", data: result });
      }

      /* ----------------- Files (no upload in VS2) ----------------- */

      case "listFiles": {
        if (!name) return res.status(400).json({ success: false, error: "assistant_name is required" });
        const base = assistant_host ? normalizeAssistantBase(assistant_host) : await getAssistantBase(name);
        // VS2: drop page_token, support optional JSON `filter`
        const result = await listFiles(base, name, data?.filter);
        return res.status(200).json({ success: true, type: "listFiles", data: result });
      }

      case "deleteFile": {
        if (!name) return res.status(400).json({ success: false, error: "assistant_name is required" });
        if (!data?.file_id) return res.status(400).json({ success: false, error: "file_id is required" });
        const base = assistant_host ? normalizeAssistantBase(assistant_host) : await getAssistantBase(name);
        const result = await deleteFile(base, name, data.file_id);
        return res.status(200).json({ success: true, type: "deleteFile", data: result });
      }

      // File upload deferred to second wave
      case "store": {
        return res.status(501).json({
          success: false,
          error: "File upload deferred (VS2). Use Pinecone console for now.",
          details: "REST multipart upload will be implemented in VS3.",
          limits: LIMITS,
        });
      }

      default:
        return res.status(400).json({
          success: false,
          error: "Invalid action",
          supported_actions: [
            "chat",
            "search",
            "describeAssistant",
            "listAssistants",
            "listFiles",
            "deleteFile",
            "store", // deferred
          ],
        });
    }
  } catch (err) {
    console.error("Pinecone Assistant API error:", err);
    const { status = 500, message = "Unknown error", details } = normalizeError(err);
    return res.status(status).json({ success: false, error: message, details });
  }
};

/* ----------------- Helpers ----------------- */

function normalizeAssistantBase(host) {
  // Ensure scheme and `/assistant` suffix on any provided assistant_host
  const url = host.startsWith("http") ? new URL(host) : new URL(`https://${host}`);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/assistant") ? path : `${path}/assistant`;
  // remove trailing slash for consistency
  return url.toString().replace(/\/$/, "");
}

async function getAssistantBase(assistantName) {
  const now = Date.now();
  const cached = hostCache.get(assistantName);
  if (cached && cached.expiresAt > now) return cached.host;

  const url = `https://api.pinecone.io/assistant/assistants/${encodeURIComponent(assistantName)}`;
  const resp = await doFetch(url, {
    method: "GET",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "X-Pinecone-API-Version": API_VERSION,
    },
  });
  const data = await resp.json();
  if (!data.host) throw new Error("Assistant response missing 'host'");

  // normalize host + append `/assistant`
  const hostUrl = data.host.startsWith("http") ? data.host : `https://${data.host}`;
  const base = normalizeAssistantBase(hostUrl);

  hostCache.set(assistantName, { host: base, expiresAt: now + HOST_CACHE_TTL_MS });
  return base;
}

/* ----------------- Runtime ----------------- */

// (chat is implemented in the switch; no extra helpers needed here)

/* ----------------- Search ----------------- */

// (search is implemented in the switch; no extra helpers needed here)

/* ----------------- Admin ----------------- */

async function describeAssistant(assistantName) {
  const url = `https://api.pinecone.io/assistant/assistants/${encodeURIComponent(assistantName)}`;
  const resp = await doFetch(url, {
    method: "GET",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "X-Pinecone-API-Version": API_VERSION,
    },
  });
  return resp.json();
}

async function listAssistants() {
  const url = "https://api.pinecone.io/assistant/assistants";
  const resp = await doFetch(url, {
    method: "GET",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "X-Pinecone-API-Version": API_VERSION,
    },
  });
  return resp.json();
}

/* ----------------- File mgmt (no upload in VS2) ----------------- */

async function listFiles(base, assistantName, filter) {
  const url = new URL(`${base}/files/${encodeURIComponent(assistantName)}`);
  // VS2: allow optional JSON `filter`
  if (filter) url.searchParams.set("filter", JSON.stringify(filter));

  const resp = await doFetch(url.toString(), {
    method: "GET",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "X-Pinecone-API-Version": API_VERSION,
    },
  });
  return resp.json();
}

async function deleteFile(base, assistantName, fileId) {
  const url = `${base}/files/${encodeURIComponent(assistantName)}/${encodeURIComponent(fileId)}`;
  const resp = await doFetch(url, {
    method: "DELETE",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "X-Pinecone-API-Version": API_VERSION,
    },
  });

  // VS2: expect 200 acknowledgement; tolerate 204 just in case
  if (resp.status === 200 || resp.status === 204) return { deleted: true, file_id: fileId };
  return resp.json();
}

/* ----------------- Fetch wrapper ----------------- */

async function doFetch(url, opts, retries = 2) {
  const resp = await fetch(url, opts);

  if (resp.status === 429 && retries > 0) {
    const ra = parseInt(resp.headers.get("retry-after") || "0", 10);
    const delay = Number.isFinite(ra) && ra > 0
      ? ra * 1000
      : (3 - retries) * 500 + Math.floor(Math.random() * 200);
    await new Promise((r) => setTimeout(r, delay));
    return doFetch(url, opts, retries - 1);
  }

  if (!resp.ok) throw await enrich(resp);
  return resp;
}

async function enrich(resp, prefix = "Request failed") {
  let details;
  try {
    // Try JSON body first
    details = await resp.json();
  } catch {
    try {
      details = await resp.text();
    } catch {
      details = null;
    }
  }
  const e = new Error(`${prefix}: ${resp.status} ${resp.statusText}`);
  e.__http = true;
  e.status = resp.status;
  e.details = { url: resp.url, body: details };
  return e;
}

function normalizeError(err) {
  if (err?.__http) return { status: err.status, message: err.message, details: err.details };
  return { message: err?.message || String(err) };
}
