import fetch from "node-fetch";
import formidable from "formidable";
import fs from "fs/promises";

export const config = { api: { bodyParser: false } };

const ALLOWED_STEMS = new Set(["voice", "drum", "bass", "piano", "electric_guitar", "strings"]);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const license = process.env.LALAL_API_KEY;
  if (!license) return res.status(500).json({ error: "Server misconfigured: missing LALAL_API_KEY" });

  // Handle multipart/form-data (file upload)
  if ((req.headers['content-type'] || '').includes('multipart/form-data')) {
    try {
      const form = formidable({ maxFileSize: 80 * 1024 * 1024 });
      const { fields, files } = await new Promise((resolve, reject) => {
        form.parse(req, (err, fields, files) => {
          if (err) reject(err);
          else resolve({ fields, files });
        });
      });

      // Normalize fields
      const action = Array.isArray(fields.action) ? fields.action[0] : fields.action;
      const stem = Array.isArray(fields.stem) ? fields.stem[0] : fields.stem;
      const audioFile = files.audio_file;

      if (action !== "upload_file")
        return res.status(400).json({ error: "Invalid action for file upload", message: "Use action='upload_file'" });

      if (!ALLOWED_STEMS.has(stem))
        return res.status(400).json({ error: "Invalid stem", message: "Allowed: " + [...ALLOWED_STEMS].join(", ") });

      if (!audioFile)
        return res.status(400).json({ error: "No audio file provided", message: "Missing audio_file in upload" });

      // Read file as buffer (Vercel serverless compatible)
      const buffer = await fs.readFile(audioFile.filepath);

      // Prepare FormData for LALAL.AI using form-data package
      const FormData = (await import('form-data')).default;
      const formData = new FormData();
      formData.append('audio_file', buffer, {
        filename: audioFile.originalFilename,
        contentType: audioFile.mimetype
      });

      // Upload to LALAL.AI
      const uploadRes = await fetch("https://www.lalal.ai/api/upload/", {
        method: "POST",
        headers: { "Authorization": license, ...formData.getHeaders() },
        body: formData,
      });
      const uploadData = await uploadRes.json();

      // Clean up temp file (async)
      if (audioFile.filepath) {
        try { await fs.unlink(audioFile.filepath); } catch {}
      }

      if (!uploadRes.ok || uploadData.status !== 'success') {
        return res.status(502).json({ error: "Upload failed", message: uploadData.error || "Failed to upload" });
      }

      // Start processing
      const params = JSON.stringify([{ id: uploadData.id, stem }]);
      const processRes = await fetch("https://www.lalal.ai/api/split/", {
        method: "POST",
        headers: {
          Authorization: license,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ params }),
      });
      const processData = await processRes.json();

      if (processData.status !== "success") {
        return res.status(502).json({ error: "Processing initialization failed", message: "Unable to start audio processing" });
      }

      // Return uploadId to frontend for polling
      return res.status(200).json({
        success: true,
        uploadId: uploadData.id,
        message: "Upload and processing started successfully"
      });

    } catch (err) {
      return res.status(500).json({ error: "Processing failed", message: err.message || "An error occurred" });
    }
  }

  // Handle JSON requests (polling/check_status/action)
  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });
  await new Promise(resolve => req.on('end', resolve));
  let payload = {};
  try { payload = JSON.parse(body); } catch {}
  const { action, uploadId } = payload;

  if (action === "check_status") {
    if (!uploadId)
      return res.status(400).json({ error: "Upload ID required" });

    try {
      const checkRes = await fetch("https://www.lalal.ai/api/check/", {
        method: "POST",
        headers: {
          Authorization: license,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ id: uploadId }),
      });
      const checkData = await checkRes.json();
      const taskInfo = checkData?.result?.[uploadId];
      const taskState = taskInfo?.task?.state;

      if (taskState === "success") {
        const processingResult = taskInfo.split;
        return res.status(200).json({
          ok: true,
          id: uploadId,
          stem_removed: taskInfo.stem,
          back_track_url: processingResult.back_track,
          stem_track_url: processingResult.stem_track,
          message: `${taskInfo.stem === 'voice' ? 'Vocals' : taskInfo.stem} removed successfully`
        });
      } else if (taskState === "error" || taskState === "cancelled") {
        return res.status(502).json({ error: "Processing failed", message: "Audio processing encountered an error" });
      } else {
        return res.status(200).json({ processing: true, status: taskState || 'processing', message: "Still processing your audio..." });
      }
    } catch (err) {
      return res.status(500).json({ error: "Status check failed", message: "Unable to check processing status" });
    }
  }

  // Add action=check_limit if you want (demo only, will reset on every deploy)
  if (action === "check_limit") {
    // Always allow for demo
    return res.status(200).json({ remaining: 3, limit: 3, can_upload: true });
  }

  return res.status(400).json({ error: "Invalid action specified" });
}
