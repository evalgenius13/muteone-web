// pages/api/separate.js
// Next.js API route — LALAL.AI upload → split → poll → return ONE file (no length/size limits)

import formidable from "formidable";
import fetch from "node-fetch";
import { createReadStream } from "fs";

export const config = { api: { bodyParser: false } };

// --- Simple in-memory rate limiting ---
const DAILY_LIMIT = 2;
const dailyUploads = new Map();

function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "127.0.0.1"
  );
}
function checkRateLimit(ip) {
  const today = new Date().toDateString();
  const data = dailyUploads.get(ip);
  if (!data || data.date !== today) {
    dailyUploads.set(ip, { count: 0, date: today });
    return true;
  }
  return data.count < DAILY_LIMIT;
}
function incrementRateLimit(ip) {
  const today = new Date().toDateString();
  const data = dailyUploads.get(ip) || { count: 0, date: today };
  dailyUploads.set(ip, { count: data.count + 1, date: today });
}
function decrementRateLimit(ip) {
  const data = dailyUploads.get(ip);
  if (data) {
    data.count = Math.max(0, data.count - 1);
    dailyUploads.set(ip, data);
  }
}

// Allowed stems (LALAL official names)
const ALLOWED_STEMS = new Set([
  "voice",
  "drum",
  "bass",
  "piano",
  "electric_guitar",
  "acoustic_guitar",
  "synthesizer",
  "strings",
  "wind",
]);

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip = getClientIP(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: "Daily limit exceeded",
      message: "You have reached your daily limit of 2 uploads. Try again tomorrow!",
    });
  }

  const license = process.env.LALAL_API_KEY;
  if (!license) return res.status(500).json({ error: "Server configuration error" });

  try {
    // Parse multipart form (file + stem)
    const { fields, files } = await new Promise((resolve, reject) => {
      const form = formidable({
        multiples: false,
        keepExtensions: true,
      });
      form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })));
    });

    const stem = String(fields.stem || "").trim();
    if (!ALLOWED_STEMS.has(stem)) {
      return res.status(400).json({
        error: "Invalid stem",
        message: "Choose one of: " + [...ALLOWED_STEMS].join(", "),
      });
    }

    const file = files.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    // --- Step 1: Upload to LALAL ---
    const uploadResp = await fetch("https://www.lalal.ai/api/upload/", {
      method: "POST",
      headers: {
        Authorization: `license ${license}`,
        "Content-Disposition": `attachment; filename="${file.originalFilename || "input"}"`,
      },
      body: createReadStream(file.filepath),
    });

    if (!uploadResp.ok) {
      const text = await uploadResp.text().catch(() => "");
      return res.status(502).json({ error: "Upload failed", detail: text || "Bad response" });
    }

    const uploadJson = await uploadResp.json();
    const uploadId = uploadJson.id;

    // --- Step 2: Request split (one stem only) ---
    const params = JSON.stringify([{ id: uploadId, stem }]);
    const splitResp = await fetch("https://www.lalal.ai/api/split/", {
      method: "POST",
      headers: {
        Authorization: `license ${license}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ params }),
    });
    const splitJson = await splitResp.json().catch(() => ({}));
    if (splitJson?.status !== "success") {
      return res.status(502).json({
        error: "Processing initialization failed",
        detail: splitJson || null,
      });
    }

    // --- Step 3: Poll until complete ---
    const maxAttempts = 120; // ~4 min @ 2s interval
    let attempt = 0;
    let result = null;

    while (attempt < maxAttempts) {
      const checkResp = await fetch("https://www.lalal.ai/api/check/", {
        method: "POST",
        headers: {
          Authorization: `license ${license}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ id: uploadId }),
      });
      const checkJson = await checkResp.json().catch(() => ({}));
      const info = checkJson?.result?.[uploadId];
      const state = info?.task?.state;

      if (state === "success") {
        result = info.split; // contains { back_track, stem_track }
        break;
      }
      if (state === "error" || state === "cancelled") {
        return res.status(502).json({
          error: "Processing failed",
          detail: info?.task?.error || "Unknown",
        });
      }

      await new Promise((r) => setTimeout(r, 2000));
      attempt++;
    }

    if (!result) {
      return res.status(504).json({
        error: "Processing timeout",
        message: "Please try again later.",
      });
    }

    // --- Success: increment usage and return ONE file (back_track only) ---
    incrementRateLimit(ip);

    return res.status(200).json({
      ok: true,
      id: uploadId,
      stem_removed: stem,
      file_url: result.back_track, // only the final file
      message: `${stem} removed successfully`,
    });
  } catch (err) {
    decrementRateLimit(ip);
    console.error("separate API error:", err);
    return res.status(500).json({ error: "Server error", message: "Please try again later." });
  }
}
