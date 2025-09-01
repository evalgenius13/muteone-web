import formidable from "formidable";
import uploads from "../lib/uploads.js";

export const config = {
  api: { bodyParser: false } // required for formidable
};

// Helper to set CORS headers
function setCORSHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  setCORSHeaders(res);

  // Handle preflight OPTIONS request
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    setCORSHeaders(res); // Just in case
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const form = formidable({ multiples: false, keepExtensions: true });

    form.parse(req, (err, fields, files) => {
      setCORSHeaders(res); // Set again in callback

      if (err) {
        console.error("Form parse error:", err);
        return res.status(500).json({ error: "File upload failed" });
      }

      const file = files.file;
      if (!file) return res.status(400).json({ error: "No file provided" });

      // Metadata from extension
      const filename = fields.filename?.[0] || file.originalFilename || "capture.wav";
      const size = parseInt(fields.fileSize?.[0] || file.size || 0, 10);
      const duration = parseInt(fields.estimatedDuration?.[0] || 0, 10);

      // Generate ID
      const uploadId = Math.random().toString(36).slice(2, 10);

      // Save to shared store
      uploads.set(uploadId, {
        filename,
        size,
        duration,
        storedAt: Date.now(),
        filepath: file.filepath
      });

      console.log(`✅ Received ${filename} (${size} bytes) → uploadId: ${uploadId}`);

      return res.status(200).json({ uploadId });
    });
  } catch (err) {
    setCORSHeaders(res); // Set again for errors
    console.error("Receive error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}