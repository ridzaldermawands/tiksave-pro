// ============================================================
// server.js - TikTok Downloader (tanpa watermark) via RapidAPI
// Butuh: Node.js 18+, paket: express, dotenv
// ============================================================
require("dotenv").config();

const express = require("express");
const path = require("path");
const { Readable } = require("stream");

const app = express();
app.use(express.json());

// ------------------------------------------------------------
// 1) KONFIGURASI RAPIDAPI (diisi lewat Environment Variables / .env)
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST;
const RAPIDAPI_PATH = process.env.RAPIDAPI_PATH || "/";

if (!RAPIDAPI_KEY || !RAPIDAPI_HOST) {
  console.warn(
    "[PERINGATAN] RAPIDAPI_KEY / RAPIDAPI_HOST belum diisi (Environment Variables / .env)"
  );
}

// ------------------------------------------------------------
// Helper: respons seragam (ok + success supaya cocok dengan frontend)
// ------------------------------------------------------------
function sendOk(res, data, cached) {
  return res.json({ ok: true, success: true, cached: !!cached, data });
}

function sendErr(res, status, message) {
  return res
    .status(status)
    .json({ ok: false, success: false, error: message, message });
}

// ------------------------------------------------------------
// 2) CACHE SEDERHANA (hemat kuota 400 request/bulan)
// ------------------------------------------------------------
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 menit
const CACHE_MAX = 500;
const cache = new Map();

function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.time > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function setCache(key, data) {
  if (cache.size >= CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { time: Date.now(), data });
}

// ------------------------------------------------------------
// 3) BATAS REQUEST PER IP
// ------------------------------------------------------------
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 10;
const hits = new Map();

function rateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "ip";
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_MAX) {
    return sendErr(res, 429, "Terlalu banyak permintaan. Coba lagi sebentar.");
  }
  list.push(now);
  hits.set(ip, list);
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) {
    const fresh = list.filter((t) => now - t < RATE_WINDOW_MS);
    if (fresh.length) hits.set(ip, fresh);
    else hits.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

// ------------------------------------------------------------
// 4) VALIDASI LINK TIKTOK
// ------------------------------------------------------------
function isTikTokUrl(value) {
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    const h = u.hostname.toLowerCase();
    return h === "tiktok.com" || h.endsWith(".tiktok.com");
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
// 5) FORMAT HASIL DARI RAPIDAPI (field API berbentuk array -> ambil [0])
// ------------------------------------------------------------
function formatResult(data) {
  const first = (v) => (Array.isArray(v) ? v[0] : v) || null;

  const images = Array.isArray(data.images) ? data.images : [];
  const video = first(data.video);
  const description = first(data.description);

  return {
    id: first(data.videoid),
    author: first(data.author),
    description,
    title: description,
    region: first(data.region),
    avatar: first(data.avatar_thumb),
    cover: first(data.cover),
    video, // tanpa watermark
    video_no_watermark: video,
    watermarked: first(data.OriginalWatermarkedVideo),
    music: first(data.music),
    stats: { views: 0, likes: 0, shares: 0 },
    isVideo: data.is_video !== false && images.length === 0,
    images,
  };
}

// ------------------------------------------------------------
// 6) PANGGIL RAPIDAPI
// ------------------------------------------------------------
async function fetchFromRapidApi(tiktokUrl) {
  const endpoint =
    `https://${RAPIDAPI_HOST}${RAPIDAPI_PATH}` +
    `?url=${encodeURIComponent(tiktokUrl)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    const r = await fetch(endpoint, {
      method: "GET",
      headers: {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST,
      },
      signal: controller.signal,
    });

    if (r.status === 403) {
      throw { status: 502, message: "API belum di-subscribe atau key salah." };
    }
    if (r.status === 429) {
      throw { status: 503, message: "Kuota API bulan ini habis." };
    }
    if (!r.ok) {
      throw { status: 502, message: `API error (${r.status}).` };
    }

    return await r.json();
  } catch (err) {
    if (err.name === "AbortError") {
      throw { status: 504, message: "API terlalu lama merespons." };
    }
    if (err.status) throw err;
    throw { status: 502, message: "Gagal menghubungi API." };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------
// 7) ROUTE: ambil info video
//    GET  /api/download?url=LINK_TIKTOK
//    POST /api/download   body: { "url": "LINK_TIKTOK" }
// ------------------------------------------------------------
app.all("/api/download", rateLimit, async (req, res) => {
  const tiktokUrl = String(
    (req.method === "GET" ? req.query.url : req.body && req.body.url) || ""
  ).trim();

  if (!tiktokUrl) {
    return sendErr(res, 400, "Link TikTok wajib diisi.");
  }
  if (!isTikTokUrl(tiktokUrl)) {
    return sendErr(res, 400, "Link bukan dari TikTok.");
  }
  if (!RAPIDAPI_KEY || !RAPIDAPI_HOST) {
    return sendErr(res, 500, "Server belum dikonfigurasi (Environment Variables).");
  }

  const cached = getCache(tiktokUrl);
  if (cached) return sendOk(res, cached, true);

  try {
    const raw = await fetchFromRapidApi(tiktokUrl);
    const result = formatResult(raw);

    if (!result.video && result.images.length === 0) {
      return sendErr(res, 404, "Video tidak ditemukan atau bersifat privat.");
    }

    setCache(tiktokUrl, result);
    sendOk(res, result, false);
  } catch (err) {
    sendErr(res, err.status || 500, err.message || "Terjadi kesalahan server.");
  }
});

// ------------------------------------------------------------
// 8) ROUTE: unduh file lewat server
//    GET /api/file?src=URL_CDN&name=nama-file.mp4
// ------------------------------------------------------------
function isTikTokCdn(value) {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      /(^|\.)tiktokcdn[a-z0-9-]*\.com$/i.test(u.hostname)
    );
  } catch {
    return false;
  }
}

app.get("/api/file", rateLimit, async (req, res) => {
  const src = String(req.query.src || "");
  const safeName =
    String(req.query.name || "tiktok.mp4").replace(/[^a-zA-Z0-9._-]/g, "_") ||
    "tiktok.mp4";

  if (!isTikTokCdn(src)) {
    return sendErr(res, 400, "Sumber file tidak diizinkan.");
  }

  try {
    const upstream = await fetch(src);
    if (!upstream.ok || !upstream.body) {
      return sendErr(res, 502, "Gagal mengambil file.");
    }

    res.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") || "application/octet-stream"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    const len = upstream.headers.get("content-length");
    if (len) res.setHeader("Content-Length", len);

    Readable.fromWeb(upstream.body).pipe(res);
  } catch {
    sendErr(res, 502, "Gagal mengunduh file.");
  }
});

// ------------------------------------------------------------
// 9) FILE WEBSITE (frontend) - folder "public"
// ------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));

// ------------------------------------------------------------
// 10) JALANKAN SERVER
// ------------------------------------------------------------
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server jalan di http://localhost:${PORT}`);
  });
}

module.exports = app;
