// api/separate.js - Proxy approach for LALAL.AI
import fetch from "node-fetch";
import formidable from "formidable";
import fs from "fs";

export const config = { 
  api: { 
    bodyParser: false // Let formidable handle multipart parsing
  } 
};

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
const processingStatus = new Map();

// Clean up old entries to prevent memory leaks
function cleanupOldEntries() {
  const today = new Date().toDateString();
  for (const [ip, data] of dailyUploads.entries()) {
    if (data.date !== today) {
      dailyUploads.delete(ip);
    }
  }
  
  const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
  for (const [uploadId, status] of processingStatus.entries()) {
    if (status.timestamp < tenMinutesAgo) {
      processingStatus.delete(uploadId);
    }
  }
}

// Run cleanup periodically
setInterval(cleanupOldEntries, 60 * 60 * 1000);

function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "127.0.0.1"
  );
}

function checkRateLimit(ip) {
  if (WHITELISTED_IPS.has(ip)) {
    return { 
      allowed: true, 
      remaining: DAILY_LIMIT,
      whitelisted: true 
    };
  }

  const today = new Date().toDateString();
  const data = dailyUploads.get(ip);
  if (!data || data.date !== today) {
    dailyUploads.set(ip, { count: 0, date: today, processing: false });
    return { allowed: true, remaining: DAILY_LIMIT };
  }
  
  if (data.processing) {
    return { allowed: false, remaining: Math.max(0, DAILY_LIMIT - data.count), error: "Already processing a file" };
  }
  
  return { 
    allowed: data.count < DAILY_LIMIT, 
    remaining: Math.max(0, DAILY_LIMIT - data.count)
  };
}

function setProcessing(ip, processing) {
  if (WHITELISTED_IPS.has(ip)) return;
  
  const today = new Date().toDateString();
  const data = dailyUploads.get(ip) || { count: 0, date: today };
  data.processing = processing;
  dailyUploads.set(ip, data);
}

function incrementRateLimit(ip) {
  if (WHITELISTED_IPS.has(ip)) return;
  
  const today = new Date().toDateString();
  const data = dailyUploads.get(ip) || { count: 0, date: today, processing: false };
  data.count += 1;
  data.processing = false;
  dailyUploads.set(ip, data);
}

function decrementRateLimit(ip) {
  if (WHITELISTED_IPS.has(ip)) return;
  
  const data = dailyUploads.get(ip);
  if (data) {
    data.count = Math.max(0, data.count - 1);
    data.processing = false;
    dailyUploads.set(ip, data);
  }
}

const ALLOWED_STEMS = new Set([
  "voice", "drum", "bass", "piano", "electric_guitar", 
  "acoustic_guitar", "synthesizer", "strings", "wind",
]);

// Parse form data helper
function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = new formidable.IncomingForm({
      maxFileSize: 80 * 1024 * 1024, // 80MB limit
    });
    
    form.parse(req, (err, fields, files) => {
      if (err) {
        reject(err);
      } else {
        // Handle both single values and arrays from formidable
        const normalizedFields = {};
        for (const [key, value] of Object.entries(fields)) {
          normalizedFields[key] = Array.isArray(value) ? value[0] : value;
        }
        
        const normalizedFiles = {};
        for (const [key, value] of Object.entries(files)) {
          normalizedFiles[key] = Array.isArray(value) ? value[0] : value;
        }
        
        resolve({ fields: normalizedFields, files: normalizedFiles });
      }
    });
  });
}

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

  cleanupOldEntries();

  try {
    // Check if this is a file upload (multipart) or JSON request
    const contentType = req.headers['content-type'] || '';
    
    if (contentType.includes('multipart/form-data')) {
      // Handle file upload
      const { fields, files } = await parseForm(req);
      const action = fields.action;
      const stem = fields.stem;
      const audioFile = files.audio_file;

      if (action !== 'upload_file') {
        return res.status(400).json({ error: "Invalid action for file upload" });
      }

      if (!ALLOWED_STEMS.has(stem)) {
        return res.status(400).json({
          error: "Invalid stem",
          message: "Choose one of: " + [...ALLOWED_STEMS].join(", "),
        });
      }

      if (!audioFile) {
        return res.status(400).json({ error: "No audio file provided" });
      }

      // Check rate limit
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

      // File size validation
      if (audioFile.size > 80 * 1024 * 1024) {
        return res.status(413).json({
          error: "File too large",
          message: "File must be under 80MB."
        });
      }

      setProcessing(ip, true);

      try {
        // Create FormData for LALAL.AI
        const FormData = (await import('form-data')).default;
        const formData = new FormData();
        formData.append('audio_file', fs.createReadStream(audioFile.filepath), {
          filename: audioFile.originalFilename,
          contentType: audioFile.mimetype
        });

        console.log(`${ip} uploading ${audioFile.originalFilename} (${audioFile.size} bytes) - ${stem}`);

        // Upload to LALAL.AI
        const uploadResponse = await fetch("https://www.lalal.ai/api/upload/", {
          method: "POST",
          headers: {
            "Authorization": `license ${license}`,
            ...formData.getHeaders()
          },
          body: formData,
        });

        const uploadResult = await uploadResponse.json();

        if (!uploadResponse.ok || uploadResult.status !== 'success') {
          console.error("LALAL.AI upload failed:", uploadResult);
          decrementRateLimit(ip);
          return res.status(502).json({
            error: "Upload failed",
            message: uploadResult.error || "Failed to upload to processing service"
          });
        }

        const uploadId = uploadResult.id;

        // Start processing
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

        const splitResult = await splitResponse.json();
        
        if (splitResult?.status !== "success") {
          console.error("Split request failed:", splitResult);
          decrementRateLimit(ip);
          return res.status(502).json({
            error: "Processing initialization failed",
            message: "Unable to start audio processing"
          });
        }

        // Store processing status
        processingStatus.set(uploadId, {
          status: 'processing',
          stem: stem,
          ip: ip,
          timestamp: Date.now()
        });

        console.log(`${ip} processing started for ${uploadId} - ${stem}`);

        return res.status(200).json({
          success: true,
          uploadId: uploadId,
          message: "Upload and processing started successfully"
        });

      } catch (error) {
        console.error("Processing error:", error);
        decrementRateLimit(ip);
        return res.status(500).json({
          error: "Processing failed",
          message: "An error occurred during processing"
        });
      } finally {
        // Clean up temp file
        if (audioFile && audioFile.filepath) {
          try {
            fs.unlinkSync(audioFile.filepath);
          } catch (e) {
            console.warn("Failed to clean up temp file:", e);
          }
        }
      }

    } else {
      // Handle JSON requests (status check, limit check)
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      
      await new Promise(resolve => {
        req.on('end', resolve);
      });

      const { action, uploadId } = JSON.parse(body);

      if (action === 'check_status') {
        if (!uploadId) {
          return res.status(400).json({ error: "Upload ID required" });
        }

        const statusInfo = processingStatus.get(uploadId);
        if (!statusInfo) {
          return res.status(404).json({
            error: "Upload not found",
            message: "This upload ID was not found or has expired."
          });
        }

        try {
          const checkResponse = await fetch("https://www.lalal.ai/api/check/", {
            method: "POST",
            headers: {
              Authorization: `license ${license}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ id: uploadId }),
          });

          const checkResult = await checkResponse.json();
          const taskInfo = checkResult?.result?.[uploadId];
          const taskState = taskInfo?.task?.state;

          if (taskState === "success") {
            const processingResult = taskInfo.split;
            
            incrementRateLimit(statusInfo.ip);
            processingStatus.delete(uploadId);
            
            const newRateCheck = checkRateLimit(statusInfo.ip);
            
            console.log(`Processing complete for ${statusInfo.ip}. ${newRateCheck.remaining} uploads remaining.`);

            return res.status(200).json({
              ok: true,
              id: uploadId,
              stem_removed: statusInfo.stem,
              back_track_url: processingResult.back_track,
              stem_track_url: processingResult.stem_track,
              message: `${statusInfo.stem === 'voice' ? 'Vocals' : statusInfo.stem} removed successfully`,
              remaining_uploads: newRateCheck.remaining
            });
          } else if (taskState === "error" || taskState === "cancelled") {
            console.error("Processing failed:", taskInfo?.task?.error);
            decrementRateLimit(statusInfo.ip);
            processingStatus.delete(uploadId);
            return res.status(502).json({
              error: "Processing failed",
              message: "Audio processing encountered an error"
            });
          } else {
            return res.status(200).json({
              processing: true,
              status: taskState || 'processing',
              message: "Still processing your audio..."
            });
          }

        } catch (error) {
          console.error("Status check error:", error);
          return res.status(500).json({
            error: "Status check failed",
            message: "Unable to check processing status"
          });
        }

      } else if (action === 'check_limit') {
        const rateCheck = checkRateLimit(ip);
        return res.status(200).json({
          remaining: rateCheck.remaining,
          limit: DAILY_LIMIT,
          can_upload: rateCheck.allowed && !rateCheck.error
        });
        
      } else {
        return res.status(400).json({ error: "Invalid action specified" });
      }
    }

  } catch (error) {
    console.error("API error:", error);
    setProcessing(ip, false);
    
    return res.status(500).json({
      error: "Server error",
      message: "An unexpected error occurred"
    });
  }
}
