// api/separate.js - Fixed Version with Memory Management
import fetch from "node-fetch";

export const config = { api: { bodyParser: true } };

// Simple in-memory rate limiting with cleanup
const DAILY_LIMIT = 3;
const MAX_DURATION_SECONDS = 300; // 5 minutes

// Load whitelisted IPs from environment variables
const getWhitelistedIPs = () => {
  const whitelist = process.env.WHITELISTED_IPS || '';
  return new Set(
    whitelist
      .split(',')
      .map(ip => ip.trim())
      .filter(ip => ip.length > 0)
  );
};

const WHITELISTED_IPS = getWhitelistedIPs();
const dailyUploads = new Map();

// Clean up old entries to prevent memory leaks
function cleanupOldEntries() {
  const today = new Date().toDateString();
  for (const [ip, data] of dailyUploads.entries()) {
    if (data.date !== today) {
      dailyUploads.delete(ip);
    }
  }
}

// Run cleanup periodically
setInterval(cleanupOldEntries, 60 * 60 * 1000); // Every hour

function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "127.0.0.1"
  );
}

function checkRateLimit(ip) {
  // Check if IP is whitelisted - bypass all rate limits
  if (WHITELISTED_IPS.has(ip)) {
    return { 
      allowed: true, 
      remaining: 999, // Show high number for whitelisted IPs
      whitelisted: true 
    };
  }

  const today = new Date().toDateString();
  const data = dailyUploads.get(ip);
  if (!data || data.date !== today) {
    dailyUploads.set(ip, { count: 0, date: today, processing: false });
    return { allowed: true, remaining: DAILY_LIMIT };
  }
  
  // Prevent concurrent processing from same IP (unless whitelisted)
  if (data.processing) {
    return { allowed: false, remaining: Math.max(0, DAILY_LIMIT - data.count), error: "Already processing a file" };
  }
  
  return { 
    allowed: data.count < DAILY_LIMIT, 
    remaining: Math.max(0, DAILY_LIMIT - data.count)
  };
}

function setProcessing(ip, processing) {
  // Skip processing tracking for whitelisted IPs
  if (WHITELISTED_IPS.has(ip)) return;
  
  const today = new Date().toDateString();
  const data = dailyUploads.get(ip) || { count: 0, date: today };
  data.processing = processing;
  dailyUploads.set(ip, data);
}

function incrementRateLimit(ip) {
  // Skip rate limiting for whitelisted IPs
  if (WHITELISTED_IPS.has(ip)) return;
  
  const today = new Date().toDateString();
  const data = dailyUploads.get(ip) || { count: 0, date: today, processing: false };
  data.count += 1;
  data.processing = false;
  dailyUploads.set(ip, data);
}

function decrementRateLimit(ip) {
  // Skip rate limiting for whitelisted IPs  
  if (WHITELISTED_IPS.has(ip)) return;
  
  const data = dailyUploads.get(ip);
  if (data) {
    data.count = Math.max(0, data.count - 1);
    data.processing = false;
    dailyUploads.set(ip, data);
  }
}

// LALAL.AI supported stems
const ALLOWED_STEMS = new Set([
  "voice", "drum", "bass", "piano", "electric_guitar", 
  "acoustic_guitar", "synthesizer", "strings", "wind",
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

  // Clean up old entries on each request
  cleanupOldEntries();

  try {
    const { action, filename, stem, uploadId, fileSize, estimatedDuration } = req.body;

    // Only validate stem for actions that require it (not check_limit)
    if (action !== 'check_limit' && !ALLOWED_STEMS.has(stem)) {
      return res.status(400).json({
        error: "Invalid stem",
        message: "Choose one of: " + [...ALLOWED_STEMS].join(", "),
      });
    }

    if (action === 'upload') {
      // Check rate limit and concurrent processing
      const rateCheck = checkRateLimit(ip);
      if (!rateCheck.allowed) {
        if (rateCheck.error) {
          return res.status(429).json({
            error: "Processing in progress",
            message: rateCheck.error,
            remaining: rateCheck.remaining
          });
        }
        return res.status(429).json({
          error: "Daily limit exceeded",
          message: `You have reached your daily limit of ${DAILY_LIMIT} uploads. Try again tomorrow!`,
          remaining: 0
        });
      }

      // Server-side file size validation
      if (fileSize && fileSize > 50 * 1024 * 1024) {
        return res.status(413).json({
          error: "File too large",
          message: "File must be under 50MB. For 5-minute limit, try a smaller file or lower quality."
        });
      }

      // Server-side duration validation (critical - client could be bypassed)
      if (estimatedDuration && estimatedDuration > MAX_DURATION_SECONDS) {
        return res.status(413).json({
          error: "Audio too long",
          message: `Audio must be under 5 minutes. Your file is approximately ${Math.floor(estimatedDuration/60)}:${(estimatedDuration%60).toString().padStart(2,'0')}.`
        });
      }

      // Set processing flag to prevent concurrent uploads
      setProcessing(ip, true);

      console.log(`${ip} requesting upload auth for ${filename} - ${stem} (${rateCheck.remaining - 1} remaining)`);

      return res.status(200).json({
        auth_header: `license ${license}`,
        message: "Upload authorized",
        remaining: rateCheck.remaining - 1
      });

    } else if (action === 'process') {
      if (!uploadId) {
        setProcessing(ip, false);
        return res.status(400).json({ error: "Upload ID required" });
      }

      console.log(`${ip} processing upload ID: ${uploadId} with stem: ${stem}`);

      try {
        // Request separation
        const params = JSON.stringify([{ 
          id: uploadId, 
          stem: stem
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
          decrementRateLimit(ip); // Don't count failed attempts
          return res.status(502).json({
            error: "Processing initialization failed",
            message: "Unable to start audio processing. Your upload count has not been affected."
          });
        }

        // Poll for completion with proper timeout
        const maxAttempts = 180; // 6 minutes max
        let attempt = 0;
        let processingResult = null;

        while (attempt < maxAttempts) {
          try {
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
              decrementRateLimit(ip);
              return res.status(502).json({
                error: "Processing failed",
                message: "Audio processing encountered an error. Your upload count has not been affected."
              });
            }

            await new Promise((resolve) => setTimeout(resolve, 2000));
            attempt++;
          } catch (pollError) {
            console.error("Polling error:", pollError);
            // Continue polling unless it's a critical error
            attempt++;
          }
        }

        if (!processingResult) {
          decrementRateLimit(ip);
          return res.status(504).json({
            error: "Processing timeout",
            message: "Processing is taking longer than expected. Your upload count has not been affected."
          });
        }

        // Success! 
        incrementRateLimit(ip);
        const newRateCheck = checkRateLimit(ip);
        
        console.log(`Processing complete for ${ip}. ${newRateCheck.remaining} uploads remaining today.`);

        return res.status(200).json({
          ok: true,
          id: uploadId,
          stem_removed: stem,
          back_track_url: processingResult.back_track,
          stem_track_url: processingResult.stem_track,
          message: `${stem === 'voice' ? 'Vocals' : stem} removed successfully`,
          remaining_uploads: newRateCheck.remaining
        });

      } catch (processError) {
        console.error("Processing error:", processError);
        decrementRateLimit(ip);
        return res.status(500).json({
          error: "Processing failed",
          message: "An error occurred during processing. Your upload count has not been affected."
        });
      }

    } else if (action === 'check_limit') {
      // Limit check doesn't require stem validation - use default
      const rateCheck = checkRateLimit(ip);
      return res.status(200).json({
        remaining: rateCheck.remaining,
        limit: DAILY_LIMIT,
        can_upload: rateCheck.allowed && !rateCheck.error
      });
      
    } else {
      return res.status(400).json({ error: "Invalid action specified" });
    }

  } catch (error) {
    console.error("API error:", error);
    
    // Clean up processing state on any error
    setProcessing(ip, false);
    
    return res.status(500).json({
      error: "Server error",
      message: "An unexpected error occurred. Please try again."
    });
  }
}
