const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
import uploads from "../lib/uploads.js";

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

    // Check limit action - returns usage info
    if (action === "check_limit") {
      const rateCheck = checkRateLimit(ip);
      return res.status(200).json({
        remaining: rateCheck.remaining,
        limit: DAILY_LIMIT,
        can_upload: rateCheck.allowed && !rateCheck.error
      });
    }

    // Upload action - prepare for file upload (return auth header for direct upload)
    if (action === "upload") {
      if (!filename || !fileSize) {
        return res.status(400).json({ error: "Missing filename or fileSize" });
      }
      
      const rateCheck = checkRateLimit(ip);
      if (!rateCheck.allowed) {
        return res.status(429).json({ 
          error: rateCheck.error || "Daily limit reached. Try again tomorrow.", 
          remaining: rateCheck.remaining 
        });
      }
      
      if (fileSize > 80 * 1024 * 1024) {
        return res.status(413).json({ error: "File too large (over 80MB)" });
      }
      
      if (estimatedDuration && estimatedDuration > MAX_DURATION_SECONDS) {
        return res.status(413).json({ error: "Audio too long (over 5 minutes)" });
      }
      
      // Mark as processing to prevent concurrent uploads
      setProcessing(ip, true);
      
      return res.status(200).json({ 
        auth_header: `license ${license}`,
        remaining: rateCheck.remaining - 1
      });
    }

    // Process action - handle the separation after upload
    if (action === "process") {
      if (!uploadId) {
        setProcessing(ip, false);
        return res.status(400).json({ error: "Upload ID required" });
      }
      
      if (!ALLOWED_STEMS.has(stem)) {
        setProcessing(ip, false);
        return res.status(400).json({ error: "Invalid stem" });
      }

      try {
        // Step 1: Initiate processing on LALAL.AI
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

        // Step 2: Poll for completion
        let attempt = 0;
        let processingResult = null;
        const maxAttempts = 180; // 6 minutes maximum

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
          
          // Wait 2 seconds before next check
          await new Promise(resolve => setTimeout(resolve, 2000));
          attempt++;
        }

        if (!processingResult) {
          decrementRate(ip);
          return res.status(504).json({ error: "Processing timeout" });
        }

        // Success - increment usage and return result
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