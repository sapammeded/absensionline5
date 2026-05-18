// ==================== GIP ELITE WORKER v4.5 - MEDED ALL IN v1 ====================
// KREDENSIAL DIKEMBALIKAN FULL KE MEDED7373 SESUAI PERINTAH
const ADMIN_PASSWORD = "meded7373";
const ADMIN_TOKEN = "meded7373_token_secure";

// CONFIGURATION MASTER KEY SECURE UNTUK SIGNATURE KE GAS
const MASTER_KEY = "meded7373";

// URL GOOGLE APPS SCRIPT LU (TETAP SAMA)
const GOOGLE_SHEETS_WEBHOOK =
  "https://script.google.com/macros/s/AKfycbyisvT35x-YjBKfJM8yz0Zwb4-ao-utbYdTEiR29mgcowuAJTuW7IBle9EGXOjmRnnJEA/exec";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

// ==================== DURABLE OBJECT ====================
export class AtomicConsumeDO {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/consume" && request.method === "POST") {
      const body = await request.json();
      const id = body.id;
      const ttl = body.ttl || 300;

      const result = await this.state.blockConcurrencyWhile(async () => {
        const now = Date.now();
        const existing = await this.storage.get(id);

        if (existing && existing.expires > now) {
          return { consumed: false };
        }

        await this.storage.put(id, {
          consumed: true,
          expires: now + (ttl * 1000)
        });

        return { consumed: true };
      });

      return new Response(JSON.stringify(result), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  }
}

// ==================== MEMORY RATE LIMIT ====================
const rateMap = new Map();
function checkRateLimit(key, limit = 10, windowMs = 60000) {
  const now = Date.now();
  const entry = rateMap.get(key);

  if (!entry || entry.reset < now) {
    rateMap.set(key, { count: 1, reset: now + windowMs });
    return true;
  }

  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

// ==================== PHOTO REPLAY ====================
const photoReplayMap = new Map();
async function simpleHash(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .slice(0, 16)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getPhotoHash(base64) {
  const len = base64.length;
  const prefix = base64.substring(0, 500);
  const middle = base64.substring(Math.floor(len / 2) - 50, Math.floor(len / 2) + 50);
  const hash = await simpleHash(prefix + middle);
  return `${len}:${hash}`;
}

function isReplay(hash) {
  const now = Date.now();
  const existing = photoReplayMap.get(hash);
  if (existing && existing > now) return true;
  photoReplayMap.set(hash, now + 300000);
  return false;
}

// ==================== HELPERS ====================
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

async function signHMAC(message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(MASTER_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ==================== WIB DATE LOGIC ====================
function getWIBDate() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });
}

function formatWIB(timestamp) {
  return new Date(timestamp).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta", weekday: "long", year: "numeric", month: "long",
    day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
}

async function getKV(env, key, fallback = null) {
  try {
    const data = await env.GIP_KV.get(key);
    return data ? JSON.parse(data) : fallback;
  } catch { return fallback; }
}

async function setKV(env, key, value, ttl = null) {
  if (value === null) {
    await env.GIP_KV.delete(key);
    return;
  }
  await env.GIP_KV.put(key, JSON.stringify(value), ttl ? { expirationTtl: ttl } : {});
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// ==================== SHEETS PUSH WITH TIMEOUT ====================
async function pushToSheets(entry) {
  if (!GOOGLE_SHEETS_WEBHOOK) return;
  const timestamp = Date.now();
  const payload = { ...entry, _timestamp: timestamp };
  const signature = await signHMAC(JSON.stringify(payload));

  try {
    const response = await fetch(GOOGLE_SHEETS_WEBHOOK, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": signature,
        "X-Timestamp": String(timestamp),
        "X-Source": "cloudflare-worker"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      console.error("GAS ERROR:", response.status);
    }
  } catch (e) { 
    console.error("Sheets push connection / timeout error:", e); 
  }
}

// ==================== ATOMIC CONSUME (DO & KV FALLBACK) ====================
async function atomicConsume(env, doId, type, id, ttl) {
  if (!doId || !env.ATOMIC_CONSUME_DO) {
    const key = `${type}:${id}`;
    const existing = await getKV(env, key, null);
    if (!existing) {
      return false;
    }
    await setKV(env, key, null);
    return true;
  }
  
  const stub = env.ATOMIC_CONSUME_DO.get(doId);
  const resp = await stub.fetch("https://internal/consume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: `${type}:${id}`, ttl })
  });
  const result = await resp.json();
  return result.consumed;
}

// ==================== ABSEN HANDLER ====================
async function handleAbsen(request, env, doId, ctx) {
  try {
    const body = await request.json();
    const { qrId, nonce, nama, lat, lng, accuracy, locationId, fingerprint, photoBase64, timestamp, jenis } = body;

    if (!qrId || !nonce || !nama || !photoBase64) {
      return json({ ok: false, code: "INVALID" }, 400);
    }

    // PATCH FINAL B — PROTECTION SENSOR DATA / VALIDASI DATA KOORDINAT AGAR TIDAK ERROR MATEMATIKA
    if (typeof lat !== "number" || typeof lng !== "number") {
      return json({ ok: false, code: "GPS_INVALID" }, 400);
    }

    if (!photoBase64.startsWith("data:image/")) {
      return json({ ok: false, code: "PHOTO_INVALID" }, 400);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const ua = request.headers.get("User-Agent") || "unknown";
    const rateKey = `${fingerprint}:${ip}:${ua}`;

    if (!checkRateLimit(rateKey)) return json({ ok: false, code: "RATE_LIMIT" }, 429);

    const now = Date.now();
    if (Math.abs(now - timestamp) > 300000) return json({ ok: false, code: "EXPIRED" }, 400);

    const qrOk = await atomicConsume(env, doId, "qr", qrId, 300);
    if (!qrOk) return json({ ok: false, code: "QR_USED" }, 400);

    const nonceOk = await atomicConsume(env, doId, "nonce", nonce, 180);
    if (!nonceOk) return json({ ok: false, code: "NONCE_USED" }, 400);

    await setKV(env, `qr:${qrId}`, null);
    await setKV(env, `nonce:${nonce}`, null);

    const photoHash = await getPhotoHash(photoBase64);
    if (isReplay(photoHash)) return json({ ok: false, code: "PHOTO_REPLAY" }, 400);

    const locations = await getKV(env, "locations", []);
    const location = locations.find(l => l.id === locationId);
    if (!location) return json({ ok: false, code: "LOCATION_INVALID" }, 400);

    const distance = calculateDistance(location.lat, location.lng, lat, lng);
    if (distance > location.radius) {
      return json({ ok: false, code: "OUTSIDE_RADIUS", distance: Math.round(distance) }, 400);
    }

    const logs = await getKV(env, "absensi_logs", []);
    const today = getWIBDate();
    const duplicate = logs.find(l => l.tanggal === today && l.fingerprint === fingerprint && l.status === jenis);
    if (duplicate) return json({ ok: false, code: "DUPLICATE" }, 400);

    const logId = `ABS-${Date.now()}`;
    const entry = {
      id: logId,
      nama: String(nama).toUpperCase(),
      location_name: location.name,
      project: location.project,
      jarak: Math.round(distance),
      accuracy, lat, lng, fingerprint,
      photo_hash: photoHash,
      timestamp,
      waktu: formatWIB(timestamp),
      status: jenis,
      tanggal: today,
      verified: true,
      created_at: now
    };

    // PATCH FINAL A — OPTIMASI STRUKTUR ARRAY DAN MEMORY MANAGEMENT PADA RAM HP ADMIN
        // SIMPAN FOTO TERPISAH DI KV AGAR LOG UTAMA TIDAK BENGKAK (TTL 7 HARI = 604800 DETIK)
    await setKV(env, `photo:${photoHash}`, { photoBase64 }, 604800);

    logs.unshift(entry);
    if (logs.length > 2000) {
      logs.length = 2000;
    }
    
    await setKV(env, "absensi_logs", logs);

    ctx.waitUntil(pushToSheets(entry));
    
    return json({ ok: true, id: logId, distance: Math.round(distance) });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// ==================== INIT DATA ====================
async function initData(env) {
  let locations = await getKV(env, "locations", null);
  if (!locations || locations.length === 0) {
    locations = [
      {
        id: "loc1",
        name: "KANTOR PUSAT",
        lat: -6.200000,
        lng: 106.816666,
        radius: 100,
        project: "DEFAULT",
        created_at: Date.now()
      }
    ];
    await setKV(env, "locations", locations);
  }

  let logs = await getKV(env, "absensi_logs", null);
  if (!logs) {
    await setKV(env, "absensi_logs", []);
  }
}

// ==================== FETCH HANDLER ====================
export default {
  async fetch(request, env, ctx) {
    await initData(env);

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    if (path === "/" || path === "/health") {
      return json({ ok: true, service: "GIP Worker", status: "ACTIVE" });
    }

    if (path === "/api/qr-token" && method === "GET") {
      const qrId = crypto.randomUUID();
      await setKV(env, `qr:${qrId}`, { created_at: Date.now() }, 300);
      return json({ ok: true, qrId });
    }

    if (path === "/api/challenge" && method === "GET") {
      const nonce = crypto.randomUUID();
      await setKV(env, `nonce:${nonce}`, { created_at: Date.now() }, 180);
      return json({ ok: true, nonce });
    }

    if (path === "/api/locations" && method === "GET") {
      const locations = await getKV(env, "locations", []);
      return json(locations);
    }

    if (path === "/api/admin/login" && method === "POST") {
      try {
        const body = await request.json();
        if ((body.password || "") !== ADMIN_PASSWORD) {
          return json({ ok: false, error: "PASSWORD_SALAH" }, 401);
        }
        return json({ ok: true, token: ADMIN_TOKEN, expires_in: 86400 });
      } catch (e) { return json({ ok: false, error: String(e) }, 500); }
    }

    // ==================== ADMIN LOCATIONS MANAGEMENT (AUTH LOCKED) ====================
    if (path === "/api/admin/locations" && method === "POST") {
      // PATCH FINAL C — CASE-INSENSITIVE HEADER EVALUATION AGAR COMPATIBLE DENGAN SEMUA BROWSER HP
      const auth = request.headers.get("Authorization") || request.headers.get("authorization") || "";
      if (auth !== `Bearer ${ADMIN_TOKEN}`) {
        return json({ ok: false, error: "UNAUTHORIZED" }, 401);
      }

      try {
        const body = await request.json();
        const { action, id, data } = body;
        let locations = await getKV(env, "locations", []);

        if (action === "ADD") {
          locations.push({
            id: crypto.randomUUID(),
            name: data.name || "",
            lat: Number(data.lat),
            lng: Number(data.lng),
            radius: Number(data.radius || 100),
            project: data.project || "",
            created_at: Date.now()
          });
        } else if (action === "UPDATE") {
          const idx = locations.findIndex(l => l.id === id);
          if (idx !== -1) {
            locations[idx] = { ...locations[idx], ...data, lat: Number(data.lat), lng: Number(data.lng), radius: Number(data.radius) };
          }
        } else if (action === "DELETE") {
          locations = locations.filter(l => l.id !== id);
        }

        await setKV(env, "locations", locations);
        return json({ ok: true, total: locations.length });
      } catch (e) { return json({ ok: false, error: String(e) }, 500); }
    }

    // ==================== ADMIN DASHBOARD REAL-TIME (AUTH LOCKED) ====================
    if (path === "/api/admin/dashboard" && method === "GET") {
      // PATCH FINAL C — CASE-INSENSITIVE HEADER EVALUATION AGAR COMPATIBLE DENGAN SEMUA BROWSER HP
      const auth = request.headers.get("Authorization") || request.headers.get("authorization") || "";
      if (auth !== `Bearer ${ADMIN_TOKEN}`) {
        return json({ ok: false, error: "UNAUTHORIZED" }, 401);
      }

      const logs = await getKV(env, "absensi_logs", []);
      const todayStr = getWIBDate();
      const todayLogs = logs.filter(l => l.tanggal === todayStr);

      return json({
        ok: true,
        stats: {
          total: logs.length,
          today: todayLogs.length,
          masuk: todayLogs.filter(l => l.status === "MASUK").length,
          pulang: todayLogs.filter(l => l.status === "PULANG").length
        },
        logs: logs.slice(0, 100)
      });
    }

    if (path === "/api/absen" && method === "POST") {
      let doId = null;
      if (env.ATOMIC_CONSUME_DO) {
        doId = env.ATOMIC_CONSUME_DO.idFromName("global");
      }
      return await handleAbsen(request, env, doId, ctx);
    }

    // ==================== PHOTO VIEWER SECURE VIA URL TOKEN ====================
    if (path === "/api/admin/photo-viewer" && method === "GET") {
      const tokenParam = url.searchParams.get("token") || "";
      if (tokenParam !== ADMIN_TOKEN) {
        return new Response("UNAUTHORIZED", { status: 401, headers: CORS_HEADERS });
      }

      const hash = url.searchParams.get("hash") || "";
      const photoData = await getKV(env, `photo:${hash}`, null);

      if (!photoData || !photoData.photoBase64) {
        return new Response("PHOTO_NOT_FOUND", { status: 404, headers: CORS_HEADERS });
      }

      try {
        const parts = photoData.photoBase64.split(",");
        const mime = parts[0].match(/:(.*?);/)[1];
        const binaryStr = atob(parts[1]);
        const len = binaryStr.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        return new Response(bytes.buffer, {
          headers: {
            "Content-Type": mime,
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=86400"
          }
        });
      } catch (e) {
        return new Response("DECODE_ERROR", { status: 500, headers: CORS_HEADERS });
      }
    }

    // ==================== EXPORT LOGS FULL (TANPA SLICE 100) ====================
    if (path === "/api/admin/export" && method === "GET") {
      const auth = request.headers.get("Authorization") || request.headers.get("authorization") || "";
      if (auth !== `Bearer ${ADMIN_TOKEN}`) {
        return json({ ok: false, error: "UNAUTHORIZED" }, 401);
      }

      const logs = await getKV(env, "absensi_logs", []);
      return json({
        ok: true,
        total: logs.length,
        logs: logs
      });
    }
    

    return json({ ok: false, error: "NOT_FOUND" }, 404);
  }
};
