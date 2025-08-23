// api/separate.js - Direct Upload Architecture
import fetch from "node-fetch";

export const config = { api: { bodyParser: true } };

// Simple in-memory rate limiting
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
    const { action, filename, stem, uploadId } = req.body;

    // Validate stem
    if (!ALLOWED_STEMS.has(stem)) {
      return res.status(400).json({
        error: "Invalid stem",
        message: "Choose one of: " + [...ALLOWED_STEMS].join(", "),
      });
    }

    if (action === 'upload') {
      // Step 1: Provide upload authorization (rate limiting commented out for testing)
      // if (!checkRateLimit(ip)) {
      //   return res.status(429).json({
      //     error: "Daily limit exceeded",
      //     message: "You have reached your daily limit of 2 uploads. Try again tomorrow!",
      //   });
      // }

      console.log(`${ip} requesting upload auth for ${filename} - ${stem}`);

      return res.status(200).json({
        auth_header: `license ${license}`,
        message: "Upload authorized"
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
        return res.status(502).json({
          error: "Processing initialization failed",
          message: "Unable to start audio processing"
        });
      }

      console.log("Processing started, polling for completion...");

      // Poll for completion
      const maxAttempts = 120; // 4 minutes max
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
          return res.status(502).json({
            error: "Processing failed",
            message: "Audio processing encountered an error"
          });
        }

        // Wait 2 seconds before next check
        await new Promise((resolve) => setTimeout(resolve, 2000));
        attempt++;
      }

      if (!processingResult) {
        return res.status(504).json({
          error: "Processing timeout",
          message: "Processing is taking longer than expected. Please try again."
        });
      }

      // Success! Increment rate limit and return result
      // Rate limiting commented out for testing
      // incrementRateLimit(ip);
      
      console.log(`Processing complete for ${ip}. Back track: ${processingResult.back_track}`);

      return res.status(200).json({
        ok: true,
        id: uploadId,
        stem_removed: stem,
        back_track_url: processingResult.back_track,
        stem_track_url: processingResult.stem_track,
        message: `${stem === 'voice' ? 'Vocals' : stem} removed successfully`
      });

    } else {
      return res.status(400).json({ error: "Invalid action specified" });
    }

  } catch (error) {
    console.error("API error:", error);
    
    // Don't count failed attempts against rate limit for processing
    // Rate limiting commented out for testing
    // if (req.body?.action === 'process') {
    //   decrementRateLimit(ip);
    // }
    
    return res.status(500).json({
      error: "Server error",
      message: "An unexpected error occurred. Please try again."
    });
  }
}
