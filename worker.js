// ==================== GIP ELITE WORKER v4.5 - HIGH SECURITY ====================
// PLATINUM MASTER PRODUCTION - STRICT VALIDATION & ANTI-FRAUD
// ALL CREDENTIALS & SIGNATURE FIXED TO: meded7373

const ADMIN_PASSWORD = "meded7373";
const ADMIN_TOKEN = "meded7373_token_secure";
const MASTER_KEY = "meded7373";

// URL GOOGLE APPS SCRIPT WEBHOOK LU
const GOOGLE_SHEETS_WEBHOOK = "https://script.google.com/macros/s/AKfycbyisvT35x-YjBKfJM8yz0Zwb4-ao-utbYdTEiR29mgcowuAJTuW7IBle9EGXOjmRnnJEA/exec";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

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
      const exist = await this.storage.get("msg_" + id);
      if (exist) return new Response(JSON.stringify({ ok: false, error: "REPLAY_ATTEMPT" }), { headers: CORS_HEADERS });
      await this.storage.put("msg_" + id, Date.now());
      return new Response(JSON.stringify({ ok: true }), { headers: CORS_HEADERS });
    }
    return new Response("DO_OK", { status: 200 });
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    }
  });
}

function getWIBDate() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatWIBTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleString("id-ID", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).replace(/\//g, "-");
}

async function setKV(env, key, value) {
  if (env.ABSENSI_KV) await env.ABSENSI_KV.put(key, JSON.stringify(value));
}

async function getKV(env, key, fallback = null) {
  if (!env.ABSENSI_KV) return fallback;
  const val = await env.ABSENSI_KV.get(key);
  return val ? JSON.parse(val) : fallback;
}

async function generateSignature(data, secret) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const msgData = encoder.encode(JSON.stringify(data));
  const cryptoKey = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // 1. GET LOCATIONS
    if (path === "/api/locations" && method === "GET") {
      const locs = await getKV(env, "locations", [
        { id: "LOC-DEFAULT", name: "SUBSTATION GIS 150KV", lat: -6.200000, lng: 106.816666, radius: 100, project: "O&M" }
      ]);
      return json(locs);
    }

    // 2. TOKEN & NONCE GENERATOR
    if (path === "/api/qr-token" && method === "GET") {
      return json({ qrId: "QR-" + crypto.randomUUID().substring(0, 8).toUpperCase(), expires_in: 300 });
    }
    if (path === "/api/challenge" && method === "GET") {
      return json({ nonce: "NONCE-" + crypto.randomUUID().substring(0, 12).toUpperCase(), expires_in: 180 });
    }

    // 3. ADMIN LOGIN
    if (path === "/api/admin/login" && method === "POST") {
      try {
        const body = await request.json();
        if ((body.password || "") !== ADMIN_PASSWORD) return json({ ok: false, error: "PASSWORD_SALAH" }, 401);
        return json({ ok: true, token: ADMIN_TOKEN, expires_in: 86400 });
      } catch (e) { return json({ ok: false, error: String(e) }, 400); }
    }

    // 4. MANAGEMENT LOKASI
    if (path === "/api/admin/locations" && method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${ADMIN_TOKEN}`) return json({ ok: false, error: "UNAUTHORIZED" }, 401);
      try {
        const body = await request.json();
        let locs = await getKV(env, "locations", []);
        if (body.action === "ADD") {
          locs.push({ id: "LOC-" + Date.now(), ...body.data });
        } else if (body.action === "UPDATE") {
          locs = locs.map(l => l.id === body.id ? { ...l, ...body.data } : l);
        } else if (body.action === "DELETE") {
          locs = locs.filter(l => l.id !== body.id);
        }
        await setKV(env, "locations", locs);
        return json({ ok: true, total: locs.length });
      } catch (e) { return json({ ok: false, error: String(e) }, 400); }
    }

    // 5. DASHBOARD REAL-TIME
    if (path === "/api/admin/dashboard" && method === "GET") {
      const auth = request.headers.get("Authorization") || request.headers.get("authorization") || "";
      if (auth !== `Bearer ${ADMIN_TOKEN}`) return json({ ok: false, error: "UNAUTHORIZED" }, 401);
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

    // 6. PROSES ABSENSI (STRICT GEOFENCE & FIXED MAPPING)
    if (path === "/api/absen" && method === "POST") {
      try {
        const payload = await request.json();
        
        // SINKRONISASI VARIABEL DENGAN INDEX.HTML v4.5 PLATINUM
        const inputNama = payload.nama;
        const inputLocId = payload.location || payload.locationId;
        const inputLat = payload.latitude || payload.lat;
        const inputLng = payload.longitude || payload.lng;
        const statusAbsen = payload.jenis || payload.status || "MASUK";

        // Jika data krusial kosong, tolak mentah-mentah!
        if (!inputNama || !inputLocId || !inputLat || !inputLng) {
          return json({ ok: false, error: "DITOLAK: Data koordinat GPS atau Nama kosong!" }, 400);
        }

        // Ambil data target lokasi dari KV database
        const locations = await getKV(env, "locations", []);
        let targetLoc = locations.find(l => l.id === inputLocId);
        
        if (!targetLoc) {
          return json({ ok: false, error: "DITOLAK: ID Lokasi proyek tidak valid!" }, 400);
        }

        // Hitung jarak murni menggunakan Haversine Formula (Akurasi Tinggi)
        const R = 6371000; 
        const dLat = (targetLoc.lat - inputLat) * Math.PI / 180;
        const dLng = (targetLoc.lng - inputLng) * Math.PI / 180;
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(targetLoc.lat * Math.PI / 180) * Math.cos(inputLat * Math.PI / 180) * Math.sin(dLng/2) * Math.sin(dLng/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        const distance = Math.round(R * c);

        // VALIDASI RADIUS GEOLOCATION - PENGUNCI ANTI-FRAUD
        if (distance > targetLoc.radius) {
          return json({ ok: false, error: `DITOLAK: Anda berada di luar area Substation (${distance} meter dari target)!` }, 400);
        }

        const photoHash = "IMG-" + crypto.randomUUID().substring(0, 8).toUpperCase();
        const waktuFull = formatWIBTime(payload.timestamp);
        const tanggalStr = getWIBDate();

        // Susun data rapi siap kirim ke code.gs
        const outData = {
          id: payload.id || "REQ-" + Date.now(),
          waktu: waktuFull,
          nama: inputNama.toUpperCase(),
          location_name: targetLoc.name,
          project: targetLoc.project || "O&M",
          jarak: distance,
          accuracy: payload.accuracy || 0,
          status: statusAbsen,
          lat: inputLat,
          lng: inputLng,
          fingerprint: payload.fingerprint || "FP-UNKNOWN",
          photo_hash: photoHash,
          timestamp: payload.timestamp || Date.now(),
          verified: true,
          tanggal: tanggalStr
        };

        // Buat Kunci Signature HMAC berbasis meded7373
        const timestampGAS = Date.now();
        const signatureGAS = await generateSignature(outData, MASTER_KEY);

        // Kirim ke Google Apps Script Webhook
        try {
          ctx.waitUntil(
            fetch(GOOGLE_SHEETS_WEBHOOK, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Source": "cloudflare-worker",
                "X-Signature": signatureGAS,
                "X-Timestamp": String(timestampGAS)
              },
              body: JSON.stringify(outData)
            })
          );
        } catch (gasErr) {
          console.error("GAS Gateway Connection Fail: ", String(gasErr));
        }

        // Simpan log ke internal Cloudflare KV
        const currentLogs = await getKV(env, "absensi_logs", []);
        currentLogs.unshift(outData);
        await setKV(env, "absensi_logs", currentLogs.slice(0, 500));

        return json({ ok: true, id: outData.id, distance });
      } catch (e) {
        return json({ ok: false, error: "SERVER_ERROR: " + String(e) }, 500);
      }
    }

    return json({ ok: false, error: "NOT_FOUND" }, 404);
  }
};
