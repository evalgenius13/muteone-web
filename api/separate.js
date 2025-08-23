// pages/api/separate.js - Correct LALAL.AI Integration
import formidable from "formidable";
import fetch from "node-fetch";
import { createReadStream } from "fs";

export const config = { api: { bodyParser: false } };

const DAILY_LIMIT = 2;
// Simple in-memory store for rate limiting
const dailyUploads = new Map();

function getClientIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]
      || req.headers["x-real-ip"]
      || req.socket?.remoteAddress
      || "127.0.0.1";
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
  data.count += 1;
  dailyUploads.set(ip, data);
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
  "voice", "drum", "bass", "piano", "electric_guitar", "acoustic_guitar",
  "synthesizer", "strings", "wind"
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
  
  // Check rate limiting
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ 
      error: "Daily limit exceeded", 
      message: "You have reached your daily limit of 2 uploads. Try again tomorrow!" 
    });
  }

  try {
    // Parse multipart form data
    const { fields, files } = await new Promise((resolve, reject) => {
      const form = formidable({ 
        multiples: false, 
        maxFileSize: 60 * 1024 * 1024, // 60MB max
        keepExtensions: true
      });
      
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve({ fields, files });
      });
    });

    // Validate stem
    const stem = String(fields.stem || "").trim();
    if (!ALLOWED_STEMS.has(stem)) {
      return res.status(400).json({ 
        error: "Invalid stem", 
        message: "Please select a valid instrument to remove",
        allowed: [...ALLOWED_STEMS] 
      });
    }

    // Validate file
    const file = files.file;
    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Check API key
    const license = process.env.LALAL_API_KEY;
    if (!license) {
      return res.status(500).json({ error: "Server configuration error" });
    }

    // Step 1: Upload to LALAL.AI
    console.log("Uploading to LALAL.AI...");
    const uploadResponse = await fetch("https://www.lalal.ai/api/upload/", {
      method: "POST",
      headers: { 
        "Authorization": `license ${license}`,
        "Content-Disposition": `attachment; filename="${file.originalFilename || "input.mp3"}"`
      },
      body: createReadStream(file.filepath)
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error("Upload failed:", errorText);
      return res.status(502).json({ 
        error: "Upload failed", 
        message: "Failed to upload to processing service"
      });
    }

    const uploadResult = await uploadResponse.json();
    const uploadId = uploadResult.id;
    const duration = uploadResult.duration || 0;

    console.log(`Upload successful. ID: ${uploadId}, Duration: ${duration}s`);

    // Enforce 5-minute limit (300 seconds)
    if (duration > 300) {
      return res.status(400).json({ 
        error: "Track too long", 
        message: "Maximum track length is 5 minutes. Your track is " + Math.ceil(duration/60) + " minutes long." 
      });
    }

    // Step 2: Request separation
    console.log("Requesting separation...");
    const params = JSON.stringify([{ 
      id: uploadId, 
      stem: stem,
      // Optional quality settings
      filter: 1,
      enhanced_processing_enabled: true
    }]);
    
    const splitResponse = await fetch("https://www.lalal.ai/api/split/", {
      method: "POST",
      headers: { 
        "Authorization": `license ${license}`, 
        "Content-Type": "application/x-www-form-urlencoded" 
      },
      body: new URLSearchParams({ params })
    });

    const splitResult = await splitResponse.json();
    if (splitResult.status !== "success") {
      console.error("Split request failed:", splitResult);
      return res.status(502).json({ 
        error: "Processing initialization failed", 
        message: "Unable to start audio processing"
      });
    }

    console.log("Processing started, polling for completion...");

    // Step 3: Poll for completion
    let attempts = 0;
    const maxAttempts = 120; // 4 minutes max polling
    let processingResult = null;

    while (attempts < maxAttempts) {
      const checkResponse = await fetch("https://www.lalal.ai/api/check/", {
        method: "POST",
        headers: { 
          "Authorization": `license ${license}`, 
          "Content-Type": "application/x-www-form-urlencoded" 
        },
        body: new URLSearchParams({ id: uploadId })
      });

      const checkResult = await checkResponse.json();
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
      await new Promise(resolve => setTimeout(resolve, 2000));
      attempts++;
    }

    if (!processingResult) {
      return res.status(504).json({ 
        error: "Processing timeout", 
        message: "Processing is taking longer than expected. Please try again."
      });
    }

    // Success! Increment rate limit and return URLs
    incrementRateLimit(ip);
    
    console.log(`Processing complete for ${ip}. Back track: ${processingResult.back_track}`);

    return res.status(200).json({
      ok: true,
      id: uploadId,
      stem_removed: stem,
      duration: Math.ceil(duration),
      back_track_url: processingResult.back_track, // WAV download URL
      stem_track_url: processingResult.stem_track, // Isolated stem (optional)
      message: `${stem === 'voice' ? 'Vocals' : stem} removed successfully`
    });

  } catch (error) {
    console.error("Processing error:", error);
    
    // Don't count failed attempts against rate limit
    decrementRateLimit(ip);
    
    return res.status(500).json({ 
      error: "Server error", 
      message: "An unexpected error occurred. Please try again."
    });
  }
}
