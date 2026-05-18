// ==================== FIX APPS SCRIPT FIELD MAPPING v4.8 + FORMAT WAKTU WAJIB ====================
// URL Deploy: https://script.google.com/macros/s/AKfycbxKUfyyaMlL3yZB0DWRYlCaa-4qhwuM8Y4EzP50mMU6PQ_nY_WNqpjZnKUbfb4EwxGe5g/exec
// Format waktu: "Senin, 18 Mei 2026 pukul 20.51.52"

const SHEET_ID = "1hjGAbTx9_MwHeZfYtr48dEN5OWcF3LmwO1BfF9vmONo";
const SHEET_NAME = "absensi_report";

// Ambil secret dari properti skrip
const SECRET = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET') || "meded7373";

// ==================== FORMAT WAKTU WAJIB ====================
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
  formatted = formatted.replace(/\./g, ":");
  const timeMatch = formatted.match(/(\d{2}):(\d{2}):(\d{2})/);
  if (timeMatch) {
    formatted = formatted.replace(/(\d{2}):(\d{2}):(\d{2})/, "$1.$2.$3");
  }
  if (!formatted.includes("pukul")) {
    const parts = formatted.split(" ");
    const time = parts.pop();
    formatted = parts.join(" ") + " pukul " + time;
  }
  return formatted;
}

// ==================== VERIFY SIGNATURE ====================
function verifySignature(rawBody, signature, timestamp) {
  if (!signature || !timestamp) return false;
  
  const now = Date.now();
  // 30 detik tolerance - anti replay attack
  if (Math.abs(now - Number(timestamp)) > 30000) {
    return false;
  }

  const expected = Utilities.computeHmacSignature(
    Utilities.MacAlgorithm.HMAC_SHA_256,
    rawBody,
    SECRET
  );
  
  const expectedHex = expected
    .map(b => ('0' + (b & 0xFF).toString(16)).slice(-2))
    .join('');
    
  return expectedHex === signature;
}

// ==================== GET SHEET ====================
function getSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);

    const headers = [[
      "WAKTU", "NAMA", "LOKASI", "PROJECT", "JARAK", "AKURASI", "STATUS", 
      "LAT", "LNG", "FINGERPRINT", "PHOTO_HASH", "ID", "TIMESTAMP", "VERIFIED", "TANGGAL"
    ]];

    sheet.getRange(1, 1, 1, headers[0].length).setValues(headers);
    sheet.getRange(1, 1, 1, headers[0].length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ==================== DUPLICATE CHECK ====================
function isDuplicate(sheet, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return false;

  const ids = sheet
    .getRange(2, 12, lastRow - 1, 1)
    .getValues()
    .flat();
  return ids.includes(id);
}

// ==================== WRITE TO SHEET ====================
function writeToSheet(data) {
  try {
    const sheet = getSheet();
    
    // Format ulang waktu jika perlu
    let waktuFormatted = data.waktu || "";
    if (waktuFormatted && !waktuFormatted.includes("pukul")) {
      waktuFormatted = formatWIBTime(data.timestamp || new Date());
    }
    
    const row = [[
      waktuFormatted,
      data.nama || "",
      data.location_name || "",
      data.project || "",
      data.jarak !== undefined ? data.jarak : "",
      data.accuracy !== undefined ? data.accuracy : "",
      data.status || "",
      data.lat || "",
      data.lng || "",
      data.fingerprint || "",
      data.photo_hash || "",
      data.id || "",
      data.timestamp || "",
      data.verified ? "YES" : "NO",
      data.tanggal || ""
    ]];

    if (isDuplicate(sheet, data.id)) {
      return { ok: true, status: "duplicate_skipped", id: data.id };
    }

    sheet.appendRow(row[0]);
    return { ok: true, status: "inserted", id: data.id };
  } catch (e) {
    return { ok: false, status: "error", error: String(e) };
  }
}

// ==================== WEBHOOK (POST) ====================
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ ok: false, error: "Empty body" });
    }

    const headers = e.headers || {};
    const signature = headers["x-signature"] || e.parameter["X-Signature"] || "";
    const timestamp = headers["x-timestamp"] || e.parameter["X-Timestamp"] || "";
    
    const rawBody = e.postData.contents;
    
    if (signature && timestamp) {
      const isValid = verifySignature(rawBody, signature, timestamp);
      if (!isValid) {
        return json({ ok: false, error: "Invalid Signature Mismatch" });
      }
    }

    const data = JSON.parse(rawBody);
    Logger.log(JSON.stringify(data));
    
    const result = writeToSheet(data);
    return json({ ok: true, result });
    
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

// ==================== HEALTH CHECK (GET) ====================
function doGet() {
  return json({
    ok: true,
    service: "GIP Absensi Webhook",
    version: "v4.8 FORMAT WAKTU WAJIB",
    status: "ACTIVE",
    secret_status: SECRET === "meded7373" ? "MATCH_MEDED" : "MISMATCH"
  });
}

// ==================== JSON HELPER ====================
function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ==================== FORCE FIX SECRET ====================
function paksaSetSecretMeded() {
  PropertiesService.getScriptProperties().setProperty('WEBHOOK_SECRET', 'meded7373');
  Logger.log("✅ SUKSES: WEBHOOK_SECRET sekarang dikunci mati ke: meded7373");
}