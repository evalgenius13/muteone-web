// Vercel API route: api/separate.js
import fetch from 'node-fetch';
import FormData from 'form-data';

// Rate limiting storage (use a simple in-memory store for demo)
// In production, use Redis or a database
const dailyUploads = new Map();

// Get client IP address
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || 
         req.headers['x-real-ip'] || 
         '127.0.0.1';
}

// Rate limiting functions
function checkRateLimit(ip) {
  const today = new Date().toDateString();
  const userData = dailyUploads.get(ip);
  
  if (!userData || userData.date !== today) {
    dailyUploads.set(ip, { count: 0, date: today });
    return true;
  }
  
  return userData.count < 2;
}

function incrementRateLimit(ip) {
  const today = new Date().toDateString();
  const userData = dailyUploads.get(ip) || { count: 0, date: today };
  userData.count += 1;
  dailyUploads.set(ip, userData);
}

// Parse multipart form data for Vercel
async function parseMultipartForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const boundary = req.headers['content-type'].split('boundary=')[1];
        
        if (!boundary) {
          return reject(new Error('No boundary found'));
        }
        
        const parts = buffer.toString().split(`--${boundary}`);
        const formData = {};
        let fileData = null;
        
        for (const part of parts) {
          if (part.includes('Content-Disposition: form-data')) {
            const lines = part.split('\r\n');
            const disposition = lines.find(line => line.includes('Content-Disposition'));
            
            if (disposition.includes('name="stem"')) {
              const stemValue = lines[lines.length - 2];
              formData.stem = stemValue;
            } else if (disposition.includes('name="file"')) {
              const filenameMatch = disposition.match(/filename="([^"]+)"/);
              if (filenameMatch) {
                const contentTypeHeader = lines.find(line => line.includes('Content-Type:'));
                const contentType = contentTypeHeader ? contentTypeHeader.split(': ')[1] : 'audio/mpeg';
                
                // Find the start of binary data (after empty line)
                const emptyLineIndex = lines.findIndex(line => line === '');
                const binaryStart = lines.slice(emptyLineIndex + 1).join('\r\n');
                
                // Remove the trailing boundary
                const binaryData = binaryStart.split('\r\n--')[0];
                
                fileData = {
                  filename: filenameMatch[1],
                  contentType: contentType,
                  data: Buffer.from(binaryData, 'binary'),
                  size: Buffer.from(binaryData, 'binary').length
                };
              }
            }
          }
        }
        
        resolve({ formData, fileData });
      } catch (error) {
        reject(error);
      }
    });
  });
}

// Estimate duration
function estimateDuration(file) {
  const sizeInMB = file.size / (1024 * 1024);
  if (file.contentType === 'audio/wav') {
    return sizeInMB * 6;
  } else {
    return sizeInMB * 60;
  }
}

// Helper functions
function getFileExtension(filename) {
  return filename.split('.').pop().toLowerCase();
}

function getBaseName(filename) {
  return filename.replace(/\.[^/.]+$/, '');
}

// Main handler
export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const clientIP = getClientIP(req);

  try {
    // Check rate limiting
    if (!checkRateLimit(clientIP)) {
      return res.status(429).json({ 
        error: 'Daily limit exceeded',
        message: 'You have reached your daily limit of 2 uploads. Try again tomorrow!'
      });
    }

    // Parse form data
    const { formData, fileData } = await parseMultipartForm(req);

    if (!fileData) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const stem = formData.stem;
    if (!stem || !['vocals', 'drums', 'bass', 'other'].includes(stem)) {
      return res.status(400).json({ error: 'Invalid stem type' });
    }

    // Validate file size (50MB limit)
    if (fileData.size > 50 * 1024 * 1024) {
      return res.status(400).json({ 
        error: 'File too large',
        message: 'Maximum file size is 50MB'
      });
    }

    // Validate file type
    const allowedTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/flac', 'audio/m4a'];
    const fileExtension = getFileExtension(fileData.filename);
    const validExtensions = ['mp3', 'wav', 'flac', 'm4a', 'ogg'];
    
    if (!allowedTypes.includes(fileData.contentType) && !validExtensions.includes(fileExtension)) {
      return res.status(400).json({ 
        error: 'Invalid file type',
        message: 'Please upload MP3, WAV, FLAC, or M4A files'
      });
    }

    // Check duration limit
    const estimatedDuration = estimateDuration(fileData);
    if (estimatedDuration > 300) { // 5:00 limit
      return res.status(400).json({ 
        error: 'Track too long',
        message: 'Maximum track length is 5 minutes'
      });
    }

    // Increment rate limit
    incrementRateLimit(clientIP);

    // Prepare LALAL.AI request
    const formDataForAPI = new FormData();
    formDataForAPI.append('file', fileData.data, {
      filename: fileData.filename,
      contentType: fileData.contentType
    });
    formDataForAPI.append('stem', stem);
    formDataForAPI.append('filter', '1');

    // Call LALAL.AI API
    const LALAL_API_KEY = process.env.LALAL_API_KEY;
    const response = await fetch('https://www.lalal.ai/api/split/', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LALAL_API_KEY}`,
        ...formDataForAPI.getHeaders()
      },
      body: formDataForAPI
    });

    if (!response.ok) {
      console.error('LALAL.AI error:', response.status, await response.text());
      
      // Decrement rate limit on failure
      const userData = dailyUploads.get(clientIP);
      if (userData) {
        userData.count = Math.max(0, userData.count - 1);
        dailyUploads.set(clientIP, userData);
      }
      
      if (response.status === 401) {
        return res.status(500).json({ error: 'Service temporarily unavailable' });
      } else if (response.status === 402) {
        return res.status(500).json({ error: 'Service quota exceeded. Please try again later.' });
      } else {
        return res.status(500).json({ error: 'Processing failed. Please try again.' });
      }
    }

    // Get processed audio
    const audioBuffer = await response.buffer();
    const filename = `${getBaseName(fileData.filename)}_no_${stem}.mp3`;
    
    // Send response
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', audioBuffer.length);
    res.send(audioBuffer);

  } catch (error) {
    console.error('API error:', error);
    res.status(500).json({ 
      error: 'Processing failed',
      message: 'Please try again'
    });
  }
}
