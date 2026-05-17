// ==================== GIP ABSENSI WORKER - SIMPLIFIED STABLE VERSION ====================
const ADMIN_PASSWORD = "meded7373";
const MASTER_KEY = "meded7373";

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
  'Content-Type': 'application/json'
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

function generateId() {
  return crypto.randomUUID();
}

// ==================== KV HELPERS dengan ERROR HANDLING ====================
async function getKV(env, key, defaultValue = null) {
  try {
    const data = await env.GIP_KV.get(key);
    if (!data) return defaultValue;
    return JSON.parse(data);
  } catch (e) {
    console.error(`KV get error for ${key}:`, e);
    return defaultValue;
  }
}

async function setKV(env, key, value) {
  try {
    await env.GIP_KV.put(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error(`KV set error for ${key}:`, e);
    return false;
  }
}

// ==================== INIT DEFAULT DATA ====================
async function initDefaultData(env) {
  try {
    let locations = await getKV(env, 'locations', null);
    if (!locations || locations.length === 0) {
      locations = [{
        id: generateId(),
        name: 'KANTOR PUSAT',
        lat: -6.200000,
        lng: 106.816666,
        radius: 100,
        project: 'DEFAULT',
        created_at: Date.now()
      }];
      await setKV(env, 'locations', locations);
    }
    
    let logs = await getKV(env, 'absensi_logs', null);
    if (!logs) await setKV(env, 'absensi_logs', []);
    
    let banned = await getKV(env, 'banned_devices', null);
    if (!banned) await setKV(env, 'banned_devices', []);
  } catch (e) {
    console.error('Init default data error:', e);
  }
}

// ==================== API HANDLERS ====================

async function handleQRToken(env) {
  const qrId = generateId();
  const now = Date.now();
  const expiresAt = now + 300000;
  
  const qrTokens = await getKV(env, 'qr_tokens', {});
  qrTokens[qrId] = { qr_id: qrId, created_at: now, expires_at: expiresAt, used: false };
  await setKV(env, 'qr_tokens', qrTokens);
  
  return jsonResponse({ ok: true, qrId, expiresAt });
}

async function handleChallenge(env) {
  const nonce = generateId() + '-' + Date.now();
  const now = Date.now();
  const expiresAt = now + 180000;
  
  const challenges = await getKV(env, 'challenges', {});
  challenges[nonce] = { nonce: nonce, created_at: now, expires_at: expiresAt, used: false };
  await setKV(env, 'challenges', challenges);
  
  return jsonResponse({ ok: true, nonce });
}

async function handleGetLocations(env) {
  const locations = await getKV(env, 'locations', []);
  return jsonResponse(locations);
}

async function handleAbsen(request, env) {
  try {
    const body = await request.json();
    const { qrId, nonce, nama, lat, lng, accuracy, locationId, fingerprint, photoBase64, timestamp, signature } = body;
    
    if (!qrId || !nonce || !nama || !lat || !lng || !locationId || !fingerprint || !photoBase64) {
      return jsonResponse({ ok: false, code: 'MISSING_FIELDS', msg: 'Missing required fields' }, 400);
    }
    
    // Cek banned device
    const bannedDevices = await getKV(env, 'banned_devices', []);
    const isBanned = bannedDevices.find(b => b.fingerprint === fingerprint);
    if (isBanned) {
      return jsonResponse({ ok: false, code: 'DEVICE_BANNED', msg: 'Perangkat diblokir!' }, 403);
    }
    
    // Validasi QR
    const qrTokens = await getKV(env, 'qr_tokens', {});
    const qrToken = qrTokens[qrId];
    if (!qrToken || qrToken.used || qrToken.expires_at < Date.now()) {
      return jsonResponse({ ok: false, code: 'INVALID_QR', msg: 'Invalid or expired QR' }, 400);
    }
    qrToken.used = true;
    await setKV(env, 'qr_tokens', qrTokens);
    
    // Validasi Nonce
    const challenges = await getKV(env, 'challenges', {});
    const challenge = challenges[nonce];
    if (!challenge || challenge.used || challenge.expires_at < Date.now()) {
      return jsonResponse({ ok: false, code: 'INVALID_NONCE', msg: 'Invalid or expired nonce' }, 400);
    }
    challenge.used = true;
    await setKV(env, 'challenges', challenges);
    
    // Get location
    const locations = await getKV(env, 'locations', []);
    const location = locations.find(l => l.id === locationId);
    if (!location) {
      return jsonResponse({ ok: false, code: 'INVALID_LOCATION', msg: 'Location not found' }, 400);
    }
    
    // Hitung jarak
    function calculateDistance(lat1, lon1, lat2, lon2) {
      const R = 6371000;
      const φ1 = lat1 * Math.PI / 180;
      const φ2 = lat2 * Math.PI / 180;
      const Δφ = (lat2 - lat1) * Math.PI / 180;
      const Δλ = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
                Math.cos(φ1) * Math.cos(φ2) *
                Math.sin(Δλ/2) * Math.sin(Δλ/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      return R * c;
    }
    
    const jarak = calculateDistance(location.lat, location.lng, lat, lng);
    const isWithinRadius = jarak <= location.radius;
    const isAnomaly = jarak > location.radius * 2;
    const isAlert = !isWithinRadius || accuracy > 50;
    
    // Generate photo hash
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(photoBase64.substring(0, 500) + Date.now()));
    const photoHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 32);
    
    // Simpan foto (optional, bisa skip kalo terlalu besar)
    let savedPhotoHash = null;
    if (photoBase64 && photoBase64.length < 300000) {
      try {
        await setKV(env, `photo_${photoHash}`, photoBase64);
        savedPhotoHash = photoHash;
      } catch(e) { console.error('Failed to save photo:', e); }
    }
    
    // Buat log
    const logId = 'ABS-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    const waktuStr = new Date(timestamp || Date.now()).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    
    const logEntry = {
      id: logId,
      nama: nama.toUpperCase(),
      fingerprint: fingerprint,
      photo_hash: savedPhotoHash || photoHash,
      lat: lat,
      lng: lng,
      accuracy: accuracy || 0,
      location_id: locationId,
      location_name: location.name,
      project: location.project,
      jarak: Math.round(jarak),
      timestamp: timestamp || Date.now(),
      waktu: waktuStr,
      alert: isAlert,
      anomaly: isAnomaly,
      created_at: Date.now()
    };
    
    // Save ke logs
    const logs = await getKV(env, 'absensi_logs', []);
    logs.unshift(logEntry);
    while (logs.length > 2000) logs.pop();
    await setKV(env, 'absensi_logs', logs);
    
    return jsonResponse({
      ok: true,
      logId,
      waktu: waktuStr,
      jarak: Math.round(jarak),
      withinRadius: isWithinRadius,
      alert: isAlert,
      anomaly: isAnomaly
    });
    
  } catch (error) {
    console.error('Absen error:', error);
    return jsonResponse({ ok: false, code: 'SERVER_ERROR', msg: error.message }, 500);
  }
}

async function handleAdminLogin(request, env) {
  try {
    const { password } = await request.json();
    if (password !== ADMIN_PASSWORD) {
      return jsonResponse({ ok: false, msg: 'Password salah!' }, 401);
    }
    
    const token = 'admin_' + Date.now() + '_' + Math.random().toString(36).substring(2, 15);
    const adminSessions = await getKV(env, 'admin_sessions', {});
    adminSessions[token] = { token: token, created_at: Date.now(), expires_at: Date.now() + 86400000 };
    await setKV(env, 'admin_sessions', adminSessions);
    
    return jsonResponse({ ok: true, token });
  } catch (error) {
    return jsonResponse({ ok: false, msg: error.message }, 500);
  }
}

async function verifyAdminToken(env, token) {
  try {
    const adminSessions = await getKV(env, 'admin_sessions', {});
    const session = adminSessions[token];
    return session && session.expires_at > Date.now();
  } catch(e) {
    return false;
  }
}

async function handleAdminDashboard(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return jsonResponse({ ok: false, msg: 'Unauthorized' }, 401);
  }
  
  const token = auth.substring(7);
  const isValid = await verifyAdminToken(env, token);
  if (!isValid) return jsonResponse({ ok: false, msg: 'Invalid token' }, 401);
  
  const logs = await getKV(env, 'absensi_logs', []);
  const locations = await getKV(env, 'locations', []);
  const banned = await getKV(env, 'banned_devices', []);
  
  const today = new Date().toDateString();
  const todayLogs = logs.filter(l => new Date(l.created_at).toDateString() === today);
  const alertLogs = logs.filter(l => l.alert === true);
  const anomalyLogs = logs.filter(l => l.anomaly === true);
  
  const formattedLogs = logs.slice(0, 200).map(log => ({
    id: log.id, nama: log.nama, waktu: log.waktu, project: log.project || '-',
    location_name: log.location_name || '-', jarak: log.jarak, accuracy: log.accuracy,
    alert: log.alert, anomaly: log.anomaly, photo_hash: log.photo_hash
  }));
  
  return jsonResponse({
    ok: true,
    stats: { total: logs.length, today: todayLogs.length, alert: alertLogs.length, anomaly: anomalyLogs.length, banned: banned.length },
    logs: formattedLogs
  });
}

async function handlePhotoViewer(request, env) {
  const url = new URL(request.url);
  const hash = url.searchParams.get('hash');
  if (!hash) return jsonResponse({ ok: false, msg: 'Missing hash' }, 400);
  
  const photo = await getKV(env, `photo_${hash}`, null);
  if (!photo) return jsonResponse({ ok: false, msg: 'Photo not found' }, 404);
  
  if (photo.startsWith('data:image')) {
    const binaryData = photo.split(',')[1];
    if (binaryData) {
      const imageBuffer = Uint8Array.from(atob(binaryData), c => c.charCodeAt(0));
      return new Response(imageBuffer, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' } });
    }
  }
  
  return jsonResponse({ ok: true, data: photo });
}

async function handleAdminLocations(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return jsonResponse({ ok: false, msg: 'Unauthorized' }, 401);
  
  const token = auth.substring(7);
  const isValid = await verifyAdminToken(env, token);
  if (!isValid) return jsonResponse({ ok: false, msg: 'Invalid token' }, 401);
  
  try {
    const { action, id, data } = await request.json();
    let locations = await getKV(env, 'locations', []);
    
    if (action === 'ADD') {
      const { name, lat, lng, radius, project } = data;
      const newLoc = { id: generateId(), name, lat, lng, radius: radius || 50, project: project || 'GENERAL', created_at: Date.now() };
      locations.push(newLoc);
      await setKV(env, 'locations', locations);
      return jsonResponse({ ok: true });
    } else if (action === 'UPDATE') {
      const { name, lat, lng, radius, project } = data;
      const index = locations.findIndex(l => l.id === id);
      if (index !== -1) {
        locations[index] = { ...locations[index], name, lat, lng, radius, project };
        await setKV(env, 'locations', locations);
      }
      return jsonResponse({ ok: true });
    } else if (action === 'DELETE') {
      locations = locations.filter(l => l.id !== id);
      await setKV(env, 'locations', locations);
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ ok: false, msg: 'Invalid action' }, 400);
  } catch (error) {
    return jsonResponse({ ok: false, msg: error.message }, 500);
  }
}

async function handleDeleteAll(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return jsonResponse({ ok: false, msg: 'Unauthorized' }, 401);
  
  const token = auth.substring(7);
  const isValid = await verifyAdminToken(env, token);
  if (!isValid) return jsonResponse({ ok: false, msg: 'Invalid token' }, 401);
  
  try {
    await setKV(env, 'absensi_logs', []);
    return jsonResponse({ ok: true, msg: 'All data deleted' });
  } catch (error) {
    return jsonResponse({ ok: false, msg: error.message }, 500);
  }
}

async function handleBulkDelete(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return jsonResponse({ ok: false, msg: 'Unauthorized' }, 401);
  
  const token = auth.substring(7);
  const isValid = await verifyAdminToken(env, token);
  if (!isValid) return jsonResponse({ ok: false, msg: 'Invalid token' }, 401);
  
  try {
    const { ids } = await request.json();
    let logs = await getKV(env, 'absensi_logs', []);
    const deleted = logs.filter(l => ids.includes(l.id)).length;
    logs = logs.filter(l => !ids.includes(l.id));
    await setKV(env, 'absensi_logs', logs);
    return jsonResponse({ ok: true, deleted });
  } catch (error) {
    return jsonResponse({ ok: false, msg: error.message }, 500);
  }
}

async function handleExport(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return jsonResponse({ ok: false, msg: 'Unauthorized' }, 401);
  
  const token = auth.substring(7);
  const isValid = await verifyAdminToken(env, token);
  if (!isValid) return jsonResponse({ ok: false, msg: 'Invalid token' }, 401);
  
  const logs = await getKV(env, 'absensi_logs', []);
  return jsonResponse({ ok: true, data: logs });
}

// ==================== MAIN HANDLER ====================
export default {
  async fetch(request, env, ctx) {
    try {
      await initDefaultData(env);
      ctx.waitUntil(Promise.resolve());
      
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;
      
      if (method === 'OPTIONS') {
        return new Response(null, { headers: CORS_HEADERS });
      }
      
      // Public routes
      if (path === '/api/qr-token' && method === 'GET') return await handleQRToken(env);
      if (path === '/api/challenge' && method === 'GET') return await handleChallenge(env);
      if (path === '/api/locations' && method === 'GET') return await handleGetLocations(env);
      if (path === '/api/absen' && method === 'POST') return await handleAbsen(request, env);
      
      // Admin routes
      if (path === '/api/admin/login' && method === 'POST') return await handleAdminLogin(request, env);
      if (path === '/api/admin/dashboard' && method === 'GET') return await handleAdminDashboard(request, env);
      if (path === '/api/admin/photo-viewer' && method === 'GET') return await handlePhotoViewer(request, env);
      if (path === '/api/admin/locations' && method === 'POST') return await handleAdminLocations(request, env);
      if (path === '/api/admin/delete-all' && method === 'POST') return await handleDeleteAll(request, env);
      if (path === '/api/admin/logs/bulk' && method === 'POST') return await handleBulkDelete(request, env);
      if (path === '/api/admin/export' && method === 'GET') return await handleExport(request, env);
      
      return jsonResponse({ ok: false, msg: 'Not found' }, 404);
      
    } catch (error) {
      console.error('Fatal error:', error);
      return jsonResponse({ ok: false, msg: 'Internal server error', error: error.message }, 500);
    }
  }
};