// api/separate.js - With Download Limits and Duration Check
import fetch from "node-fetch";

export const config = { api: { bodyParser: true } };

// Simple in-memory rate limiting
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

function checkRateLimit(ip) {
  const today = new Date().toDateString();
  const data = dailyUploads.get(ip);
  if (!data || data.date !== today) {
    dailyUploads.set(ip, { count: 0, date: today });
    return { allowed: true, remaining: DAILY_LIMIT };
  }
  return { 
    allowed: data.count < DAILY_LIMIT, 
    remaining: Math.max(0, DAILY_LIMIT - data.count)
  };
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

// LALAL.AI supported stems
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
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const ip = getClientIP(req);
  const license = process.env.LALAL_API_KEY;
  
  if (!license) {
    return res.status(500).json({ error: "Server configuration error" });
  }

  try {
    const { action, filename, stem, uploadId, fileSize, estimatedDuration } = req.body;

    // Validate stem
    if (!ALLOWED_STEMS.has(stem)) {
      return res.status(400).json({
        error: "Invalid stem",
        message: "Choose one of: " + [...ALLOWED_STEMS].join(", "),
      });
    }

    if (action === 'upload') {
      // Check rate limit
      const rateCheck = checkRateLimit(ip);
      if (!rateCheck.allowed) {
        return res.status(429).json({
          error: "Daily limit exceeded",
          message: `You have reached your daily limit of ${DAILY_LIMIT} uploads. Try again tomorrow!`,
          remaining: 0
        });
      }

      // Check file size (rough estimate: ~1MB per minute for MP3)
      if (fileSize && fileSize > 50 * 1024 * 1024) { // 50MB max
        return res.status(413).json({
          error: "File too large",
          message: "File must be under 50MB. For 5-minute limit, try a smaller file or lower quality."
        });
      }

      // Check estimated duration if provided
      if (estimatedDuration && estimatedDuration > MAX_DURATION_SECONDS) {
        return res.status(413).json({
          error: "Audio too long",
          message: `Audio must be under 5 minutes (${Math.floor(MAX_DURATION_SECONDS/60)}:${(MAX_DURATION_SECONDS%60).toString().padStart(2,'0')}). Your file is approximately ${Math.floor(estimatedDuration/60)}:${(estimatedDuration%60).toString().padStart(2,'0')}.`
        });
      }

      console.log(`${ip} requesting upload auth for ${filename} - ${stem} (${rateCheck.remaining} remaining)`);

      return res.status(200).json({
        auth_header: `license ${license}`,
        message: "Upload authorized",
        remaining: rateCheck.remaining - 1 // Will decrease after successful processing
      });

    } else if (action === 'process') {
      // Step 2: Process the uploaded file
      if (!uploadId) {
        return res.status(400).json({ error: "Upload ID required" });
      }

      console.log(`${ip} processing upload ID: ${uploadId} with stem: ${stem}`);

      // Request separation with standard settings
      const params = JSON.stringify([{ 
        id: uploadId, 
        stem: stem
        // Enhanced processing disabled to conserve credits
        // filter: 1,
        // enhanced_processing_enabled: true,
        // dereverb_enabled: true
      }]);
      
      const splitResponse = await fetch("https://www.lalal.ai/api/split/", {
        method: "POST",
        headers: {
          Authorization: `license ${license}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ params }),
      });

      const splitResult = await splitResponse.json().catch(() => ({}));
      
      if (splitResult?.status !== "success") {
        console.error("Split request failed:", splitResult);
        
        // Don't count failed processing attempts against rate limit
        decrementRateLimit(ip);
        
        return res.status(502).json({
          error: "Processing initialization failed",
          message: "Unable to start audio processing. Your upload count has not been affected."
        });
      }

      console.log("Processing started, polling for completion...");

      // Poll for completion with timeout for long audio
      const maxAttempts = 180; // 6 minutes max (for 5-minute audio + processing time)
      let attempt = 0;
      let processingResult = null;

      while (attempt < maxAttempts) {
        const checkResponse = await fetch("https://www.lalal.ai/api/check/", {
          method: "POST",
          headers: {
            Authorization: `license ${license}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ id: uploadId }),
        });

        const checkResult = await checkResponse.json().catch(() => ({}));
        const taskInfo = checkResult?.result?.[uploadId];
        const taskState = taskInfo?.task?.state;

        if (taskState === "success") {
          processingResult = taskInfo.split;
          break;
        } else if (taskState === "error" || taskState === "cancelled") {
          console.error("Processing failed:", taskInfo?.task?.error);
          
          // Don't count failed processing against rate limit
          decrementRateLimit(ip);
          
          return res.status(502).json({
            error: "Processing failed",
            message: "Audio processing encountered an error. Your upload count has not been affected."
          });
        }

        // Wait 2 seconds before next check
        await new Promise((resolve) => setTimeout(resolve, 2000));
        attempt++;
      }

      if (!processingResult) {
        // Don't count timeouts against rate limit
        decrementRateLimit(ip);
        
        return res.status(504).json({
          error: "Processing timeout",
          message: "Processing is taking longer than expected. This may happen with longer audio files. Your upload count has not been affected."
        });
      }

      // Success! Increment rate limit and return result
      incrementRateLimit(ip);
      const newRateCheck = checkRateLimit(ip);
      
      console.log(`Processing complete for ${ip}. ${newRateCheck.remaining} uploads remaining today. Back track: ${processingResult.back_track}`);

      return res.status(200).json({
        ok: true,
        id: uploadId,
        stem_removed: stem,
        back_track_url: processingResult.back_track,
        stem_track_url: processingResult.stem_track,
        message: `${stem === 'voice' ? 'Vocals' : stem} removed successfully`,
        remaining_uploads: newRateCheck.remaining
      });

    } else if (action === 'check_limit') {
      // New action to check remaining uploads
      const rateCheck = checkRateLimit(ip);
      return res.status(200).json({
        remaining: rateCheck.remaining,
        limit: DAILY_LIMIT,
        can_upload: rateCheck.allowed
      });
      
    } else {
      return res.status(400).json({ error: "Invalid action specified" });
    }

  } catch (error) {
    console.error("API error:", error);
    
    // Don't count server errors against rate limit
    if (req.body?.action === 'process') {
      decrementRateLimit(ip);
    }
    
    return res.status(500).json({
      error: "Server error",
      message: "An unexpected error occurred. Please try again. Your upload count has not been affected."
    });
  }
}
