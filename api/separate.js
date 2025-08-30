// pages/api/separate.js
import fetch from "node-fetch";

const DAILY_LIMIT = 3;
const dailyUploads = new Map();
const processingStatus = new Map();

// ---------- Rate limit helpers ----------
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
    return { allowed: true, remaining: DAILY_LIMIT };
  }
  return { allowed: data.count < DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - data.count) };
}

function incrementRateLimit(ip) {
  const today = new Date().toDateString();
  const data = dailyUploads.get(ip) || { count: 0, date: today };
  data.count++;
  dailyUploads.set(ip, data);
}

// ---------- API Handler ----------
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip = getClientIP(req);
  const license = process.env.LALAL_API_KEY;
  if (!license) return res.status(500).json({ error: "Missing LALAL_API_KEY" });

  // Parse body
  let body = "";
  req.on("data", chunk => { body += chunk.toString(); });
  await new Promise(resolve => req.on("end", resolve));
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const { action, filename, stem, uploadId } = parsed;

  // ---------- Upload (auth only) ----------
  if (action === "upload") {
    const rate = checkRateLimit(ip);
    if (!rate.allowed) {
      return res.status(429).json({ error: "Daily limit exceeded", remaining: rate.remaining });
    }
    return res.status(200).json({
      auth_header: `license ${license}`,
      remaining: rate.remaining
    });
  }

  // ---------- Process (mark tracking) ----------
  if (action === "process") {
    processingStatus.set(uploadId, { stem, ip, timestamp: Date.now() });
    return res.status(200).json({ started: true });
  }

  // ---------- Check Status ----------
  if (action === "check_status") {
    try {
      const checkRes = await fetch("https://www.lalal.ai/api/check/", {
        method: "POST",
        headers: {
          Authorization: `license ${license}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({ id: uploadId }),
      });

      const result = await checkRes.json();
      const taskInfo = result?.result?.[uploadId]?.task;

      if (!taskInfo) {
        return res.status(404).json({ error: "Not found", message: "Upload ID not found or expired" });
      }

      if (taskInfo.state === "success") {
        const split = result.result[uploadId].split;
        incrementRateLimit(ip);
        const newRate = checkRateLimit(ip);

        return res.status(200).json({
          ok: true,
          back_track_url: split.back_track,
          stem_track_url: split.stem_track,
          message: `${processingStatus.get(uploadId)?.stem || "Instrument"} removed successfully`,
          remaining_uploads: newRate.remaining
        });
      } else if (taskInfo.state === "error") {
        return res.status(500).json({ error: "Processing failed", message: "Audio processing encountered an error" });
      } else {
        return res.status(200).json({
          processing: true,
          message: "Still processing..."
        });
      }
    } catch (err) {
      return res.status(500).json({ error: "Status check failed", detail: err.message });
    }
  }

  // ---------- Check Limit ----------
  if (action === "check_limit") {
    const rate = checkRateLimit(ip);
    return res.status(200).json({
      remaining: rate.remaining,
      limit: DAILY_LIMIT,
      can_upload: rate.allowed
    });
  }

  return res.status(400).json({ error: "Invalid action" });
}
