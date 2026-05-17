// ==================== GIP ABSENSI WORKER - FINAL ====================
const ADMIN_PASSWORD = "meded7373";
const MASTER_KEY = "meded7373";
const GOOGLE_SHEETS_WEBHOOK = "https://script.google.com/macros/s/AKfycbxrWc2Wz3Mmm-hWHQO984zglIDFpd1_RdMXKMS0IRfN3ITJLQcfS1p1VA-OGp_1aEgY/exec";

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

function generateId() {
  return crypto.randomUUID();
}

async function getKV(env, key, defaultValue = null) {
  try {
    const data = await env.GIP_KV.get(key);
    return data ? JSON.parse(data) : defaultValue;
  } catch { return defaultValue; }
}

async function setKV(env, key, value) {
  await env.GIP_KV.put(key, JSON.stringify(value));
}

async function initDefaultData(env) {
  let locations = await getKV(env, 'locations', null);
  if (!locations) {
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
  if (!await getKV(env, 'absensi_logs', null)) await setKV(env, 'absensi_logs', []);
  if (!await getKV(env, 'banned_devices', null)) await setKV(env, 'banned_devices', []);
  if (!await getKV(env, 'admin_sessions', null)) await setKV(env, 'admin_sessions', {});
}

async function forwardToSheets(logEntry) {
  if (!GOOGLE_SHEETS_WEBHOOK) return;
  try {
    const sheetData = {
      waktu: logEntry.waktu,
      nama: logEntry.nama,
      lokasi: logEntry.location_name,
      project: logEntry.project,
      jarak: logEntry.jarak + "m",
      akurasi: logEntry.accuracy + "m",
      status: logEntry.status,
      lat: logEntry.lat,
      lng: logEntry.lng,
      fingerprint: logEntry.fingerprint?.substring(0, 20) || "-",
      foto_hash: logEntry.photo_hash,
      id: logEntry.id,
      timestamp: logEntry.timestamp
    };
    await fetch(GOOGLE_SHEETS_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sheetData)
    });
  } catch(e) { console.error('Sheet forward error:', e); }
}

// ==================== API HANDLERS ====================

async function handleQRToken(env) {
  const qrId = generateId();
  const qrTokens = await getKV(env, 'qr_tokens', {});
  qrTokens[qrId] = { qr_id: qrId, expires_at: Date.now() + 300000, used: false };
  await setKV(env, 'qr_tokens', qrTokens);
  return jsonResponse({ ok: true, qrId });
}

async function handleChallenge(env) {
  const nonce = generateId() + '-' + Date.now();
  const challenges = await getKV(env, 'challenges', {});
  challenges[nonce] = { nonce, expires_at: Date.now() + 180000, used: false };
  await setKV(env, 'challenges', challenges);
  return jsonResponse({ ok: true, nonce });
}

async function handleGetLocations(env) {
  return jsonResponse(await getKV(env, 'locations', []));
}

async function handleAbsen(request, env) {
  try {
    const body = await request.json();
    const { qrId, nonce, nama, lat, lng, accuracy, locationId, fingerprint, photoBase64, timestamp, jenis, signature } = body;
    
    if (!qrId || !nonce || !nama || !locationId || !fingerprint || !photoBase64) {
      return jsonResponse({ ok: false, code: 'MISSING_FIELDS' }, 400);
    }
    
    // Validasi QR
    const qrTokens = await getKV(env, 'qr_tokens', {});
    const qrToken = qrTokens[qrId];
    if (!qrToken || qrToken.used || qrToken.expires_at < Date.now()) {
      return jsonResponse({ ok: false, code: 'INVALID_QR' }, 400);
    }
    qrToken.used = true;
    await setKV(env, 'qr_tokens', qrTokens);
    
    // Validasi Nonce
    const challenges = await getKV(env, 'challenges', {});
    const challenge = challenges[nonce];
    if (!challenge || challenge.used || challenge.expires_at < Date.now()) {
      return jsonResponse({ ok: false, code: 'INVALID_NONCE' }, 400);
    }
    challenge.used = true;
    await setKV(env, 'challenges', challenges);
    
    // Dapatkan lokasi
    const locations = await getKV(env, 'locations', []);
    const location = locations.find(l => l.id === locationId);
    if (!location) return jsonResponse({ ok: false, code: 'INVALID_LOCATION' }, 400);
    
    // Hitung jarak
    const R = 6371000;
    const φ1 = lat * Math.PI/180, φ2 = location.lat * Math.PI/180;
    const Δφ = (location.lat - lat) * Math.PI/180;
    const Δλ = (location.lng - lng) * Math.PI/180;
    const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    const jarak = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const isAlert = jarak > location.radius;
    
    // Simpan foto
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(photoBase64.substring(0, 500) + Date.now()));
    const hashStr = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2,'0')).join('').substring(0,32);
    await setKV(env, `photo_${hashStr}`, photoBase64);
    
    const logId = 'ABS-' + Date.now() + '-' + Math.random().toString(36).substring(2,8).toUpperCase();
    const waktuStr = new Date().toLocaleString('id-ID', { 
      timeZone: 'Asia/Jakarta',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    
    const status = jenis || (isAlert ? "ALERT" : "NORMAL");
    
    const logEntry = {
      id: logId, 
      nama: nama.toUpperCase(), 
      fingerprint, 
      photo_hash: hashStr,
      lat, lng, 
      accuracy: accuracy || 0, 
      location_id: locationId,
      location_name: location.name, 
      project: location.project,
      jarak: Math.round(jarak), 
      timestamp: timestamp || Date.now(),
      waktu: waktuStr, 
      status: status,
      alert: isAlert, 
      anomaly: false, 
      created_at: Date.now()
    };
    
    const logs = await getKV(env, 'absensi_logs', []);
    logs.unshift(logEntry);
    if (logs.length > 2000) logs.pop();
    await setKV(env, 'absensi_logs', logs);
    
    // Kirim ke Google Sheets
    await forwardToSheets(logEntry);
    
    return jsonResponse({ ok: true, logId, waktu: waktuStr, jarak: Math.round(jarak), alert: isAlert, status: status });
  } catch(e) {
    console.error('Absen error:', e);
    return jsonResponse({ ok: false, code: 'SERVER_ERROR', msg: e.message }, 500);
  }
}

// ==================== ADMIN HANDLERS ====================

async function handleAdminLogin(request, env) {
  try {
    const { password } = await request.json();
    if (password !== ADMIN_PASSWORD) return jsonResponse({ ok: false, msg: 'Password salah!' }, 401);
    const token = 'admin_' + Date.now() + '_' + Math.random().toString(36).substring(2,15);
    const sessions = await getKV(env, 'admin_sessions', {});
    sessions[token] = { token, expires_at: Date.now() + 86400000 };
    await setKV(env, 'admin_sessions', sessions);
    return jsonResponse({ ok: true, token });
  } catch(e) {
    return jsonResponse({ ok: false, msg: e.message }, 500);
  }
}

async function verifyToken(env, token) {
  const sessions = await getKV(env, 'admin_sessions', {});
  const session = sessions[token];
  return session && session.expires_at > Date.now();
}

async function handleAdminDashboard(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return jsonResponse({ ok: false, msg: 'Unauthorized' }, 401);
  }
  const token = auth.substring(7);
  const isValid = await verifyToken(env, token);
  if (!isValid) return jsonResponse({ ok: false, msg: 'Invalid token' }, 401);
  
  const logs = await getKV(env, 'absensi_logs', []);
  const today = new Date().toISOString().split('T')[0];
  const todayLogs = logs.filter(l => {
    if (!l.waktu) return false;
    return l.waktu.includes(new Date().toLocaleDateString('id-ID').split(' ')[0]);
  });
  
  const formattedLogs = logs.slice(0, 500).map(l => ({
    id: l.id, nama: l.nama, waktu: l.waktu, project: l.project || '-',
    location_name: l.location_name || '-', jarak: l.jarak, accuracy: l.accuracy,
    status: l.status || (l.alert ? "ALERT" : "NORMAL"),
    alert: l.alert, anomaly: l.anomaly, photo_hash: l.photo_hash
  }));
  
  return jsonResponse({
    ok: true,
    stats: {
      total: logs.length,
      today: todayLogs.length,
      alert: logs.filter(l => l.alert).length,
      anomaly: 0,
      banned: 0
    },
    logs: formattedLogs
  });
}

async function handlePhotoViewer(request, env) {
  const url = new URL(request.url);
  const hash = url.searchParams.get('hash');
  if (!hash) return jsonResponse({ ok: false, msg: 'Missing hash' }, 400);
  const photo = await getKV(env, `photo_${hash}`, null);
  if (!photo) return jsonResponse({ ok: false, msg: 'Photo not found' }, 404);
  const binary = photo.split(',')[1];
  if (binary) {
    const imageBuffer = Uint8Array.from(atob(binary), c => c.charCodeAt(0));
    return new Response(imageBuffer, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' } });
  }
  return jsonResponse({ ok: true, data: photo });
}

async function handleAdminLocations(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return jsonResponse({ ok: false, msg: 'Unauthorized' }, 401);
  const token = auth.substring(7);
  const isValid = await verifyToken(env, token);
  if (!isValid) return jsonResponse({ ok: false, msg: 'Invalid token' }, 401);
  
  try {
    const { action, id, data } = await request.json();
    let locations = await getKV(env, 'locations', []);
    if (action === 'ADD') {
      const newLoc = { id: generateId(), ...data, created_at: Date.now() };
      locations.push(newLoc);
    } else if (action === 'UPDATE') {
      const idx = locations.findIndex(l => l.id === id);
      if (idx !== -1) locations[idx] = { ...locations[idx], ...data };
    } else if (action === 'DELETE') {
      locations = locations.filter(l => l.id !== id);
    }
    await setKV(env, 'locations', locations);
    return jsonResponse({ ok: true });
  } catch(e) {
    return jsonResponse({ ok: false, msg: e.message }, 500);
  }
}

async function handleDeleteAll(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return jsonResponse({ ok: false, msg: 'Unauthorized' }, 401);
  const token = auth.substring(7);
  const isValid = await verifyToken(env, token);
  if (!isValid) return jsonResponse({ ok: false, msg: 'Invalid token' }, 401);
  
  try {
    await setKV(env, 'absensi_logs', []);
    return jsonResponse({ ok: true, msg: 'All data deleted' });
  } catch(e) {
    return jsonResponse({ ok: false, msg: e.message }, 500);
  }
}

async function handleBulkDelete(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return jsonResponse({ ok: false, msg: 'Unauthorized' }, 401);
  const token = auth.substring(7);
  const isValid = await verifyToken(env, token);
  if (!isValid) return jsonResponse({ ok: false, msg: 'Invalid token' }, 401);
  
  try {
    const { ids } = await request.json();
    let logs = await getKV(env, 'absensi_logs', []);
    const deleted = ids.length;
    logs = logs.filter(l => !ids.includes(l.id));
    await setKV(env, 'absensi_logs', logs);
    return jsonResponse({ ok: true, deleted });
  } catch(e) {
    return jsonResponse({ ok: false, msg: e.message }, 500);
  }
}

async function handleExport(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return jsonResponse({ ok: false, msg: 'Unauthorized' }, 401);
  const token = auth.substring(7);
  const isValid = await verifyToken(env, token);
  if (!isValid) return jsonResponse({ ok: false, msg: 'Invalid token' }, 401);
  
  const logs = await getKV(env, 'absensi_logs', []);
  return jsonResponse({ ok: true, data: logs });
}

// ==================== MAIN HANDLER ====================
export default {
  async fetch(request, env, ctx) {
    await initDefaultData(env);
    ctx.waitUntil(Promise.resolve());
    
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    
    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    
    // Route mapping
    const routeHandlers = {
      '/api/qr-token': { method: 'GET', handler: () => handleQRToken(env) },
      '/api/challenge': { method: 'GET', handler: () => handleChallenge(env) },
      '/api/locations': { method: 'GET', handler: () => handleGetLocations(env) },
      '/api/absen': { method: 'POST', handler: () => handleAbsen(request, env) },
      '/api/admin/login': { method: 'POST', handler: () => handleAdminLogin(request, env) },
      '/api/admin/dashboard': { method: 'GET', handler: () => handleAdminDashboard(request, env) },
      '/api/admin/photo-viewer': { method: 'GET', handler: () => handlePhotoViewer(request, env) },
      '/api/admin/locations': { method: 'POST', handler: () => handleAdminLocations(request, env) },
      '/api/admin/delete-all': { method: 'POST', handler: () => handleDeleteAll(request, env) },
      '/api/admin/logs/bulk': { method: 'POST', handler: () => handleBulkDelete(request, env) },
      '/api/admin/export': { method: 'GET', handler: () => handleExport(request, env) }
    };
    
    const route = routeHandlers[path];
    if (route && route.method === method) {
      return await route.handler();
    }
    
    return jsonResponse({ ok: false, msg: 'Not found' }, 404);
  }
};