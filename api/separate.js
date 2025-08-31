import fetch from "node-fetch";
import uploads from "../../lib/uploads.js";

export const config = { api: { bodyParser: true } };

// Daily usage control
const DAILY_LIMIT = 3;
const MAX_DURATION_SECONDS = 300; // 5 minutes
const dailyUploads = new Map();

function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "127.0.0.1"
  );
}

function cleanupOldEntries() {
  const today = new Date().toDateString();
  for (const [ip, data] of dailyUploads.entries()) {
    if (data.date !== today) dailyUploads.delete(ip);
  }
}
setInterval(cleanupOldEntries, 60 * 60 * 1000);

function checkRateLimit(ip) {
  const today = new Date().toDateString();
  const data = dailyUploads.get(ip);
  if (!data || data.date !== today) {
    dailyUploads.set(ip, { count: 0, date: today, processing: false });
    return { allowed: true, remaining: DAILY_LIMIT };
  }
  if (data.processing) return { allowed: false, error: "Already processing", remaining: DAILY_LIMIT - data.count };
  return { allowed: data.count < DAILY_LIMIT, remaining: DAILY_LIMIT - data.count };
}
function setProcessing(ip, val) {
  const today = new Date().toDateString();
  const data = dailyUploads.get(ip) || { count: 0, date: today };
  data.processing = val;
  dailyUploads.set(ip, data);
}
function incrementRate(ip) {
  const today = new Date().toDateString();
  const data = dailyUploads.get(ip) || { count: 0, date: today, processing: false };
  data.count += 1;
  data.processing = false;
  dailyUploads.set(ip, data);
}
function decrementRate(ip) {
  const data = dailyUploads.get(ip);
  if (data) {
    data.count = Math.max(0, data.count - 1);
    data.processing = false;
    dailyUploads.set(ip, data);
  }
}

// Allowed stems
const ALLOWED_STEMS = new Set([
  "voice", "drum", "bass", "piano",
  "electric_guitar", "acoustic_guitar",
  "synthesizer", "strings", "wind"
]);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip = getClientIP(req);
  const license = process.env.LALAL_API_KEY;
  if (!license) return res.status(500).json({ error: "Missing LALAL_API_KEY" });

  try {
    const { action, uploadId, filename, fileSize, estimatedDuration, stem } = req.body;

    // 🔹 Get file info (from uploads store)
    if (action === "get_info") {
      if (!uploadId || !uploads.has(uploadId)) {
        return res.status(404).json({ error: "Upload not found" });
      }
      const file = uploads.get(uploadId);
      return res.status(200).json({
        filename: file.filename,
        size: file.size,
        type: "Audio file"
      });
    }

    // 🔹 Upload action (manual uploads)
    if (action === "upload") {
      if (!filename || !fileSize) return res.status(400).json({ error: "Missing filename or fileSize" });
      const newId = Math.random().toString(36).slice(2, 10);
      uploads.set(newId, { filename, size: fileSize, uploadedAt: Date.now() });
      return res.status(200).json({ uploadId: newId });
    }

    // 🔹 Check limit
    if (action === "check_limit") {
      const rateCheck = checkRateLimit(ip);
      return res.status(200).json({
        remaining: rateCheck.remaining,
        limit: DAILY_LIMIT,
        can_upload: rateCheck.allowed && !rateCheck.error
      });
    }

    // 🔹 Upload auth
    if (action === "upload_auth") {
      const rateCheck = checkRateLimit(ip);
      if (!rateCheck.allowed) {
        return res.status(429).json({ error: "Limit exceeded", remaining: rateCheck.remaining });
      }
      if (fileSize && fileSize > 80 * 1024 * 1024) {
        return res.status(413).json({ error: "File too large (>80MB)" });
      }
      if (estimatedDuration && estimatedDuration > MAX_DURATION_SECONDS) {
        return res.status(413).json({ error: "Audio too long (>5 min)" });
      }
      setProcessing(ip, true);
      return res.status(200).json({ auth_header: `license ${license}`, remaining: rateCheck.remaining - 1 });
    }

    // 🔹 Process
    if (action === "process") {
      if (!uploadId || !uploads.has(uploadId)) {
        setProcessing(ip, false);
        return res.status(400).json({ error: "Upload ID required" });
      }
      if (!ALLOWED_STEMS.has(stem)) {
        setProcessing(ip, false);
        return res.status(400).json({ error: "Invalid stem" });
      }

      try {
        const params = JSON.stringify([{ id: uploadId, stem }]);
        const splitResponse = await fetch("https://www.lalal.ai/api/split/", {
          method: "POST",
          headers: {
            Authorization: `license ${license}`,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: new URLSearchParams({ params })
        });
        const splitResult = await splitResponse.json().catch(() => ({}));

        if (splitResult?.status !== "success") {
          decrementRate(ip);
          return res.status(502).json({ error: "Processing initialization failed" });
        }

        let attempt = 0;
        let processingResult = null;
        const maxAttempts = 180;

        while (attempt < maxAttempts) {
          const checkResponse = await fetch("https://www.lalal.ai/api/check/", {
            method: "POST",
            headers: {
              Authorization: `license ${license}`,
              "Content-Type": "application/x-www-form-urlencoded"
            },
            body: new URLSearchParams({ id: uploadId })
          });
          const checkResult = await checkResponse.json().catch(() => ({}));
          const taskInfo = checkResult?.result?.[uploadId];
          const taskState = taskInfo?.task?.state;

          if (taskState === "success") {
            processingResult = taskInfo.split;
            break;
          } else if (taskState === "error" || taskState === "cancelled") {
            decrementRate(ip);
            return res.status(502).json({ error: "Processing failed" });
          }
          await new Promise(r => setTimeout(r, 2000));
          attempt++;
        }

        if (!processingResult) {
          decrementRate(ip);
          return res.status(504).json({ error: "Processing timeout" });
        }

        incrementRate(ip);
        const newRateCheck = checkRateLimit(ip);

        return res.status(200).json({
          ok: true,
          id: uploadId,
          stem_removed: stem,
          back_track_url: processingResult.back_track,
          stem_track_url: processingResult.stem_track,
          remaining_uploads: newRateCheck.remaining
        });
      } catch (err) {
        console.error("Processing error:", err);
        decrementRate(ip);
        return res.status(500).json({ error: "Processing failed" });
      }
    }

    return res.status(400).json({ error: "Invalid action" });
  } catch (err) {
    console.error("API error:", err);
    setProcessing(ip, false);
    return res.status(500).json({ error: "Server error" });
  }
}
