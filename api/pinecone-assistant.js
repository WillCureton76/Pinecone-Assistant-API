const API_VERSION = process.env.PINECONE_API_VERSION || "2025-01";
const HOST_CACHE_TTL_MS = 5 * 60 * 1000;
const hostCache = new Map();

module.exports = async function handler(req, res) {
  // CORS
  const allowed = (process.env.ALLOWED_ORIGINS || "https://chatgpt.com").split(",");
  const origin = req.headers.origin;
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Origin", allowed.includes(origin) ? origin : allowed[0] || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  // Optional bearer auth
  const AUTH_TOKEN = process.env.MONEYPENNY_AUTH_TOKEN;
  if (AUTH_TOKEN && req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  // Parse body
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
      case "chat": {
        if (!name) return res.status(400).json({ success: false, error: "assistant_name is required" });
        const base = assistant_host ? normalizeAssistantBase(assistant_host) : await getAssistantBase(name);
        const result = await chatWithAssistant(base, name, data);
        return res.status(200).json({ success: true, type: "chat", data: result });
      }
      case "search": {
        if (!name) return res.status(400).json({ success: false, error: "assistant_name is required" });
        const base = assistant_host ? normalizeAssistantBase(assistant_host) : await getAssistantBase(name);
        const result = await searchContext(base, name, data);
        return res.status(200).json({ success: true, type: "search", data: result });
      }
      case "describeAssistant": {
        if (!name) return res.status(400).json({ success: false, error: "assistant_name is required" });
        const result = await describeAssistant(name);
        return res.status(200).json({ success: true, type: "describeAssistant", data: result });
      }
      case "listAssistants": {
        const result = await listAssistants(data?.page_token);
        return res.status(200).json({ success: true, type: "listAssistants", data: result });
      }
      case "listFiles": {
        if (!name) return res.status(400).json({ success: false, error: "assistant_name is required" });
        const base = assistant_host ? normalizeAssistantBase(assistant_host) : await getAssistantBase(name);
        const result = await listFiles(base, name, data?.page_token);
        return res.status(200).json({ success: true, type: "listFiles", data: result });
      }
      case "deleteFile": {
        if (!name) return res.status(400).json({ success: false, error: "assistant_name is required" });
        if (!data?.file_id) return res.status(400).json({ success: false, error: "file_id is required" });
        const base = assistant_host ? normalizeAssistantBase(assistant_host) : await getAssistantBase(name);
        const result = await deleteFile(base, name, data.file_id);
        return res.status(200).json({ success: true, type: "deleteFile", data: result });
      }
      case "store": {
        return res.status(501).json({ 
          success: false, 
          error: "File upload temporarily disabled. Upload files through Pinecone console.",
          details: "PDF support coming soon"
        });
      }
      default:
        return res.status(400).json({ 
          success: false, 
          error: "Invalid action",
          supported_actions: ["chat", "search", "describeAssistant", "listAssistants", "listFiles", "deleteFile", "store"]
        });
    }
  } catch (err) {
    console.error("Pinecone Assistant API error:", err);
    const { status = 500, message = "Unknown error", details } = normalizeError(err);
    return res.status(status).json({ success: false, error: message, details });
  }
}

/* ---------- Helpers ---------- */

function normalizeAssistantBase(host) {
  return host.startsWith("http") ? host : `https://${host}`;
}

async function getAssistantBase(assistantName) {
  const now = Date.now();
  const cached = hostCache.get(assistantName);
  if (cached && cached.expiresAt > now) return cached.host;

  const url = `https://api.pinecone.io/assistant/assistants/${encodeURIComponent(assistantName)}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "X-Pinecone-API-Version": API_VERSION
    }
  });
  if (!resp.ok) throw enrich(resp, "Failed to describe assistant (host discovery)");
  const data = await resp.json();
  if (!data.host) throw new Error("Assistant response missing 'host'");

  // Fix: handle host with or without scheme
  const hostUrl = data.host.startsWith("http") ? data.host : `https://${data.host}`;
  const fullBase = `${hostUrl}/assistant`;

  hostCache.set(assistantName, { host: fullBase, expiresAt: now + HOST_CACHE_TTL_MS });
  return fullBase;
}

/* ---------- Runtime ---------- */

async function chatWithAssistant(base, assistantName, { message, context = [], model = "gpt-4o", filter, json_response, stream = false } = {}) {
  const payload = {
    messages: [
      ...context,
      message ? { role: "user", content: message } : null
    ].filter(Boolean),
    model,
    stream,
    ...(filter ? { filter } : {}),
    ...(json_response ? { json_response: true } : {}),
    include_highlights: true
  };

  const resp = await doFetch(`${base}/chat/${encodeURIComponent(assistantName)}`, {
    method: "POST",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "Content-Type": "application/json",
      "X-Pinecone-API-Version": API_VERSION
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  return {
    response: data.message?.content ?? "",
    citations: data.citations ?? [],
    context_snippets: data.context_snippets ?? [],
    usage: data.usage ?? {},
    model: data.model
  };
}

async function searchContext(base, assistantName, { query, messages, top_k = 10, filter } = {}) {
  const payload = messages?.length ? { messages } : (query ? { query } : null);
  if (!payload) throw new Error("search: provide 'query' or 'messages'");
  if (filter) payload.filter = filter;
  if (top_k) payload.top_k = top_k;

  const resp = await doFetch(`${base}/chat/${encodeURIComponent(assistantName)}/context`, {
    method: "POST",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "Content-Type": "application/json",
      "X-Pinecone-API-Version": API_VERSION
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  return {
    snippets: data.snippets ?? [],
    usage: data.usage ?? {},
    id: data.id
  };
}

/* ---------- Admin ---------- */

async function describeAssistant(assistantName) {
  const url = `https://api.pinecone.io/assistant/assistants/${encodeURIComponent(assistantName)}`;
  const resp = await doFetch(url, {
    method: "GET",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "X-Pinecone-API-Version": API_VERSION
    }
  });
  return resp.json();
}

async function listAssistants(pageToken) {
  const url = new URL("https://api.pinecone.io/assistant/assistants");
  if (pageToken) url.searchParams.set("page_token", pageToken);
  const resp = await doFetch(url.toString(), {
    method: "GET",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "X-Pinecone-API-Version": API_VERSION
    }
  });
  return resp.json();
}

/* ---------- File mgmt (no upload) ---------- */

async function listFiles(base, assistantName, pageToken) {
  const url = new URL(`${base}/files/${encodeURIComponent(assistantName)}`);
  if (pageToken) url.searchParams.set("page_token", pageToken);
  const resp = await doFetch(url.toString(), {
    method: "GET",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "X-Pinecone-API-Version": API_VERSION
    }
  });
  return resp.json();
}

async function deleteFile(base, assistantName, fileId) {
  const url = `${base}/files/${encodeURIComponent(assistantName)}/${encodeURIComponent(fileId)}`;
  const resp = await doFetch(url, {
    method: "DELETE",
    headers: {
      "Api-Key": process.env.PINECONE_API_KEY,
      "X-Pinecone-API-Version": API_VERSION
    }
  });
  if (resp.status === 204) return { deleted: true, file_id: fileId };
  return resp.json();
}

/* ---------- Fetch wrapper ---------- */

async function doFetch(url, opts, retries = 2) {
  const resp = await fetch(url, opts);
  if (resp.status === 429 && retries > 0) {
    await new Promise(r => setTimeout(r, (3 - retries) * 500));
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
