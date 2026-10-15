require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;

// ====== Konfigurasi ======
// Jika RAPIDAPI_KEY diisi -> pakai RapidAPI. Jika kosong -> pakai endpoint publik TikWM.
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || "tiktok-video-no-watermark2.p.rapidapi.com";
const RAPIDAPI_URL = process.env.RAPIDAPI_URL || `https://${RAPIDAPI_HOST}/`;
const TIKWM_URL = "https://www.tikwm.com/api/";

app.use(cors());
app.use(express.json({ limit: "10kb" }));
app.use(express.static("public"));

// Batasi request per IP agar kuota API tidak cepat habis
app.use(
  "/api/",
  rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: "Terlalu banyak permintaan. Coba lagi sebentar lagi." },
  })
);

// ====== Validasi URL TikTok ======
function isValidTikTokUrl(input) {
  if (typeof input !== "string") return false;
  let parsed;
  try {
    parsed = new URL(input.trim());
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return false;

  const host = parsed.hostname.toLowerCase();
  const hostOk = host === "tiktok.com" || host.endsWith(".tiktok.com");
  if (!hostOk) return false;

  // Link pendek (vm./vt.//t/) atau link video lengkap (/@user/video/ID)
  const shortHost = host === "vm.tiktok.com" || host === "vt.tiktok.com";
  const shortPath = /^\/t\/[\w-]+/.test(parsed.pathname);
  const videoPath = /^\/@[\w.\-]+\/(video|photo)\/\d+/.test(parsed.pathname);
  return shortHost || shortPath || videoPath;
}

// ====== Class error sederhana ======
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ====== Ambil data dari API ======
async function fetchFromProvider(url) {
  try {
    let res;
    if (RAPIDAPI_KEY) {
      res = await axios.get(RAPIDAPI_URL, {
        params: { url, hd: 1 },
        headers: {
          "x-rapidapi-key": RAPIDAPI_KEY,
          "x-rapidapi-host": RAPIDAPI_HOST,
        },
        timeout: 15000,
      });
    } else {
      res = await axios.get(TIKWM_URL, {
        params: { url, hd: 1 },
        timeout: 15000,
      });
    }
    return res.data;
  } catch (err) {
    if (err.response) {
      const s = err.response.status;
      if (s === 429) throw new ApiError(429, "Batas penggunaan API habis. Coba lagi nanti.");
      if (s === 401 || s === 403)
        throw new ApiError(502, "API key tidak valid atau langganan RapidAPI belum aktif.");
      throw new ApiError(502, `API penyedia mengembalikan error (${s}).`);
    }
    if (err.code === "ECONNABORTED") throw new ApiError(504, "Waktu permintaan ke API habis.");
    throw new ApiError(502, "Tidak dapat terhubung ke API penyedia.");
  }
}

// ====== Normalisasi respons (format TikWM) ======
function formatResult(body) {
  if (!body || typeof body !== "object") {
    throw new ApiError(502, "Respons API tidak valid.");
  }

  // TikWM: code 0 = sukses
  if (body.code !== undefined && body.code !== 0) {
    const msg = String(body.msg || "");
    if (/limit/i.test(msg)) throw new ApiError(429, "Batas penggunaan API habis. Coba lagi nanti.");
    throw new ApiError(404, msg || "Video tidak ditemukan atau bersifat privat.");
  }

  const d = body.data;
  if (!d) throw new ApiError(404, "Video tidak ditemukan.");

  const video = d.hdplay || d.play;
  if (!video) throw new ApiError(404, "Link video tanpa watermark tidak tersedia.");

  return {
    title: d.title || "",
    author: d.author?.nickname || d.author?.unique_id || "",
    cover: d.cover || d.origin_cover || "",
    video_no_watermark: video,
    music: d.music || d.music_info?.play || "",
    stats: {
      views: d.play_count ?? null,
      likes: d.digg_count ?? null,
      shares: d.share_count ?? null,
      comments: d.comment_count ?? null,
    },
  };
}

// ====== Endpoint utama ======
app.post("/api/download", async (req, res, next) => {
  try {
    const { url } = req.body || {};

    if (!url) throw new ApiError(400, "Field 'url' wajib diisi.");
    if (!isValidTikTokUrl(url)) throw new ApiError(400, "URL bukan link TikTok yang valid.");

    const body = await fetchFromProvider(url.trim());
    const data = formatResult(body);

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ====== Error handler ======
app.use((err, _req, res, _next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, error: "Format JSON tidak valid." });
  }
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({
    success: false,
    error: status === 500 ? "Terjadi kesalahan pada server." : err.message,
  });
});

app.listen(PORT, () => console.log(`Server berjalan di http://localhost:${PORT}`));
