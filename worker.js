// ==================== GIP ELITE WORKER v5.1 — FORMAT WAKTU WAJIB ====================
// ✅ Format: "Senin, 18 Mei 2026 pukul 20.51.52"
// ✅ Webhook baru sudah diset

const ADMIN_PASSWORD = "meded7373";
const ADMIN_TOKEN = "meded7373_token_secure";
const MASTER_KEY = "meded7373";

// ⚠️ UPDATE URL APPS SCRIPT ANDA DI SINI
const GOOGLE_SHEETS_WEBHOOK =
  "https://script.google.com/macros/s/AKfycbwwzdSvSUSdjdh8HkQ8_2oZXNBJ1VQGrwVo58clGUg8M7w_JHqt1Y0kzausna92T5T4xA/exec";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Content-Type": "application/json"
};

// ==================== RESPONSE JSON ====================
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

// ==================== PHOTO STORAGE (KV) ====================
async function storePhoto(env, hash, base64Data) {
  if (!env.GIP_KV) return false;
  await env.GIP_KV.put(`photo_${hash}`, base64Data, { expirationTtl: 86400 * 30 });
  return true;
}

async function getPhoto(env, hash) {
  if (!env.GIP_KV) return null;
  return await env.GIP_KV.get(`photo_${hash}`);
}

// ==================== FORMAT WAKTU WAJIB ====================
// Output: "Senin, 18 Mei 2026 pukul 20.51.52"
function formatWIBTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  const options = {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  };
  let formatted = d.toLocaleString("id-ID", options);
  // Ganti "pukul 20.51.52" -> titik sebagai pemisah
  formatted = formatted.replace(/\./g, ":").replace(/:/g, ".", 2);
  formatted = formatted.replace(/(\d{2})\.(\d{2})\.(\d{2})$/, "$1.$2.$3");
  // Ubah "20.51.52" menjadi "20.51.52" (sudah benar)
  // Pastikan kata "pukul" ada
  if (!formatted.includes("pukul")) {
    const parts = formatted.split(" ");
    const time = parts.pop();
    formatted = parts.join(" ") + " pukul " + time;
  }
  return formatted;
}

function getWIBDate() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ==================== KV ====================
async function setKV(env, key, value) {
  if (!env.GIP_KV) throw new Error("GIP_KV_NOT_CONNECTED");
  await env.GIP_KV.put(key, JSON.stringify(value));
}

async function getKV(env, key, fallback = null) {
  if (!env.GIP_KV) return fallback;
  try {
    const val = await env.GIP_KV.get(key);
    if (!val) return fallback;
    return JSON.parse(val);
  } catch (e) {
    console.error("KV PARSE ERROR:", key, String(e));
    return fallback;
  }
}

// ==================== HMAC ====================
async function generateSignature(data, secret) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const msgData = encoder.encode(JSON.stringify(data));
  const cryptoKey = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ==================== MAIN ====================
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ==================== HEALTH ====================
    if (path === "/health") {
      return json({ ok: true, kv: !!env.GIP_KV, time: Date.now() });
    }

    // ==================== DEBUG KV ====================
    if (path === "/debug-kv") {
      const locations = await getKV(env, "locations", []);
      return json({ ok: true, total: locations.length, locations });
    }

    // ==================== LOCATIONS ====================
    if (path === "/api/locations" && method === "GET") {
      let locs = await getKV(env, "locations", []);
      if (!Array.isArray(locs) || !locs.length) {
        locs = [{
          id: "LOC-DEFAULT",
          name: "SUBSTATION GIS 150KV",
          lat: -6.200000,
          lng: 106.816666,
          radius: 100,
          project: "O&M"
        }];
        await setKV(env, "locations", locs);
      }
      return json(locs);
    }

    // ==================== QR ====================
    if (path === "/api/qr-token" && method === "GET") {
      return json({ qrId: "QR-" + crypto.randomUUID().substring(0, 8).toUpperCase(), expires_in: 300 });
    }

    // ==================== NONCE ====================
    if (path === "/api/challenge" && method === "GET") {
      return json({ nonce: "NONCE-" + crypto.randomUUID().substring(0, 12).toUpperCase(), expires_in: 180 });
    }

    // ==================== LOGIN ====================
    if (path === "/api/admin/login" && method === "POST") {
      try {
        const body = await request.json();
        if ((body.password || "") !== ADMIN_PASSWORD) {
          return json({ ok: false, error: "PASSWORD_SALAH" }, 401);
        }
        return json({ ok: true, token: ADMIN_TOKEN, expires_in: 86400 });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 400);
      }
    }

    // ==================== LOCATION MANAGER ====================
    if (path === "/api/admin/locations" && method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${ADMIN_TOKEN}`) {
        return json({ ok: false, error: "UNAUTHORIZED" }, 401);
      }
      try {
        const body = await request.json();
        let locs = await getKV(env, "locations", []);
        if (!Array.isArray(locs)) locs = [];
        if (body.action === "ADD") {
          const newLoc = {
            id: "LOC-" + Date.now(),
            name: String(body.data.name || "").trim(),
            lat: Number(body.data.lat),
            lng: Number(body.data.lng),
            radius: Number(body.data.radius || 50),
            project: String(body.data.project || "GENERAL").trim()
          };
          if (!newLoc.name || isNaN(newLoc.lat) || isNaN(newLoc.lng)) {
            return json({ ok: false, error: "INVALID_LOCATION_DATA" }, 400);
          }
          locs.push(newLoc);
        } else if (body.action === "UPDATE") {
          locs = locs.map(l => l.id === body.id ? { ...l, ...body.data } : l);
        } else if (body.action === "DELETE") {
          locs = locs.filter(l => l.id !== body.id);
        }
        await setKV(env, "locations", locs);
        const verify = await getKV(env, "locations", []);
        return json({ ok: true, total: verify.length, locations: verify });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    // ==================== DASHBOARD ====================
    if (path === "/api/admin/dashboard" && method === "GET") {
      const auth = request.headers.get("Authorization") || "";
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
        logs: logs.slice(0, 500)
      });
    }

    // ==================== EXPORT LOGS ====================
    if (path === "/api/admin/export" && method === "GET") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${ADMIN_TOKEN}`) {
        return json({ ok: false, error: "UNAUTHORIZED" }, 401);
      }
      const logs = await getKV(env, "absensi_logs", []);
      return json({ ok: true, logs: logs, exported_at: Date.now() });
    }

    // ==================== DELETE LOGS ====================
    if (path === "/api/admin/delete" && method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${ADMIN_TOKEN}`) {
        return json({ ok: false, error: "UNAUTHORIZED" }, 401);
      }
      try {
        const body = await request.json();
        let logs = await getKV(env, "absensi_logs", []);
        let idsToDelete = new Set();
        if (body.ids && Array.isArray(body.ids)) {
          body.ids.forEach(id => idsToDelete.add(id));
        } else if (body.id) {
          idsToDelete.add(body.id);
        }
        if (idsToDelete.size === 0) {
          return json({ ok: false, error: "NO_IDS_PROVIDED" }, 400);
        }
        const newLogs = logs.filter(l => !idsToDelete.has(l.id));
        await setKV(env, "absensi_logs", newLogs);
        return json({ ok: true, deleted: logs.length - newLogs.length, remaining: newLogs.length });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    // ==================== PHOTO VIEWER ====================
    if (path === "/api/admin/photo-viewer" && method === "GET") {
      const token = url.searchParams.get("token");
      const hash = url.searchParams.get("hash");
      if (token !== ADMIN_TOKEN) {
        return new Response("UNAUTHORIZED", { status: 401 });
      }
      const photoBase64 = await getPhoto(env, hash);
      if (photoBase64) {
        let base64Data = photoBase64.includes(',') ? photoBase64.split(',')[1] : photoBase64;
        const binary = atob(base64Data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Response(bytes, { headers: { "Content-Type": "image/jpeg", ...CORS_HEADERS } });
      }
      return new Response("PHOTO_NOT_FOUND", { status: 404, headers: CORS_HEADERS });
    }

    // ==================== ABSEN ====================
    if (path === "/api/absen" && method === "POST") {
      try {
        const payload = await request.json();
        const inputNama = payload.nama;
        const inputLocId = payload.location || payload.locationId;
        const inputLat = Number(payload.latitude || payload.lat);
        const inputLng = Number(payload.longitude || payload.lng);
        const statusAbsen = payload.jenis || payload.status || "MASUK";

        if (!inputNama || !inputLocId || isNaN(inputLat) || isNaN(inputLng)) {
          return json({ ok: false, error: "DATA_GPS_INVALID" }, 400);
        }

        const locations = await getKV(env, "locations", []);
        const targetLoc = locations.find(l => l.id === inputLocId);
        if (!targetLoc) {
          return json({ ok: false, error: "LOKASI_TIDAK_VALID" }, 400);
        }

        // HAVERSINE
        const R = 6371000;
        const dLat = (targetLoc.lat - inputLat) * Math.PI / 180;
        const dLng = (targetLoc.lng - inputLng) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(targetLoc.lat * Math.PI / 180) *
          Math.cos(inputLat * Math.PI / 180) *
          Math.sin(dLng / 2) * Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = Math.round(R * c);

        if (distance > targetLoc.radius) {
          return json({ ok: false, error: `DILUAR_RADIUS (${distance}m)` }, 400);
        }

        const photoHash = "IMG-" + crypto.randomUUID().substring(0, 8).toUpperCase();

        // FORCE SERVER TIME
        const serverNow = new Date();
        const forcedTimestamp = serverNow.getTime();
        
        if (payload.photoBase64) {
          await storePhoto(env, photoHash, payload.photoBase64);
        }
        
        const outData = {
          id: payload.id || "REQ-" + Date.now(),
          waktu: formatWIBTime(forcedTimestamp),
          nama: inputNama.toUpperCase(),
          location_name: targetLoc.name,
          project: targetLoc.project,
          jarak: distance,
          accuracy: payload.accuracy || 0,
          status: statusAbsen,
          lat: inputLat,
          lng: inputLng,
          fingerprint: payload.fingerprint || "FP-UNKNOWN",
          photo_hash: photoHash,
          timestamp: forcedTimestamp,
          verified: true,
          tanggal: getWIBDate()
        };

        // SEND TO GAS
        let gasResult = null;
        try {
          const signatureGAS = await generateSignature(outData, MASTER_KEY);
          const gasRes = await fetch(GOOGLE_SHEETS_WEBHOOK, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Source": "cloudflare-worker",
              "X-Signature": signatureGAS,
              "X-Timestamp": String(Date.now())
            },
            body: JSON.stringify(outData)
          });
          const gasText = await gasRes.text();
          gasResult = { status: gasRes.status, response: gasText };
          console.log("GAS:", gasResult);
        } catch (gasErr) {
          gasResult = { error: String(gasErr) };
          console.error("GAS ERROR:", gasErr);
        }

        // SAVE TO KV
        let logs = await getKV(env, "absensi_logs", []);
        if (!Array.isArray(logs)) logs = [];
        logs.unshift(outData);
        await setKV(env, "absensi_logs", logs.slice(0, 500));

        return json({ ok: true, id: outData.id, distance, gas: gasResult });
      } catch (e) {
        return json({ ok: false, error: "SERVER_ERROR: " + String(e) }, 500);
      }
    }

    // ==================== TEST GAS ====================
    if (path === "/test-gas") {
      try {
        const testData = {
          nama: "TEST_DIRECT",
          status: "MASUK",
          location_name: "TEST",
          jarak: 1,
          waktu: formatWIBTime(Date.now())
        };
        const signatureTest = await generateSignature(testData, MASTER_KEY);
        const gasRes = await fetch(GOOGLE_SHEETS_WEBHOOK, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Source": "cloudflare-worker",
            "X-Signature": signatureTest,
            "X-Timestamp": String(Date.now())
          },
          body: JSON.stringify(testData)
        });
        const gasText = await gasRes.text();
        return json({ ok: true, gas_status: gasRes.status, gas_response: gasText });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    // ==================== 404 ====================
    return json({ ok: false, error: "NOT_FOUND" }, 404);
  }
};