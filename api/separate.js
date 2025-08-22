// Backend API for LALAL.AI integration - Free Tier
import fetch from 'node-fetch';
import FormData from 'form-data';
import multer from 'multer';

// LALAL.AI API configuration
const LALAL_API_URL = 'https://www.lalal.ai/api/split/';
const LALAL_API_KEY = process.env.LALAL_API_KEY;

// Rate limiting storage (in production, use Redis or database)
const dailyUploads = new Map(); // IP -> { count, date }

// Configure multer for file uploads (free tier limits)
const upload = multer({
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit for free tier
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/flac', 'audio/m4a', 'audio/ogg'];
    if (allowedTypes.includes(file.mimetype) || file.originalname.match(/\.(mp3|wav|flac|m4a|ogg)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'), false);
    }
  }
});

// Rate limiting function
function checkRateLimit(ip) {
  const today = new Date().toDateString();
  const userData = dailyUploads.get(ip);
  
  if (!userData || userData.date !== today) {
    // Reset for new day
    dailyUploads.set(ip, { count: 0, date: today });
    return true;
  }
  
  return userData.count < 2; // 2 uploads per day limit
}

function incrementRateLimit(ip) {
  const today = new Date().toDateString();
  const userData = dailyUploads.get(ip) || { count: 0, date: today };
  userData.count += 1;
  dailyUploads.set(ip, userData);
}

// Get client IP address
function getClientIP(req) {
  return req.headers['x-forwarded-for'] || 
         req.headers['x-real-ip'] || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress ||
         (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
         '127.0.0.1';
}

// Main API endpoint
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const clientIP = getClientIP(req);

  try {
    // Check rate limiting first
    if (!checkRateLimit(clientIP)) {
      return res.status(429).json({ 
        error: 'Daily limit exceeded',
        message: 'You have reached your daily limit of 2 free uploads. Try again tomorrow!'
      });
    }

    // Handle file upload
    await new Promise((resolve, reject) => {
      upload.single('file')(req, res, (err) => {
        if (err) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            reject(new Error('File too large. Maximum size is 50MB for free tier.'));
          } else {
            reject(err);
          }
        } else {
          resolve();
        }
      });
    });

    const { file } = req;
    const { stem } = req.body;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!stem || !['vocals', 'drums', 'bass', 'other'].includes(stem)) {
      return res.status(400).json({ error: 'Invalid stem type' });
    }

    // Estimate duration and enforce 3:30 limit
    const estimatedDuration = estimateDuration(file);
    if (estimatedDuration > 210) { // 3:30 in seconds
      return res.status(400).json({ 
        error: 'Track too long',
        message: 'Free tier supports tracks up to 3:30 minutes. Please upload a shorter track.'
      });
    }

    // Increment rate limit counter before processing
    incrementRateLimit(clientIP);

    // Prepare LALAL.AI request
    const formData = new FormData();
    formData.append('file', file.buffer, {
      filename: file.originalname,
      contentType: file.mimetype
    });
    
    formData.append('stem', stem);
    formData.append('filter', '1'); // High quality filter

    // Call LALAL.AI API
    console.log(`Processing request from ${clientIP}: ${file.originalname}, stem: ${stem}`);
    const response = await fetch(LALAL_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LALAL_API_KEY}`,
        ...formData.getHeaders()
      },
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('LALAL.AI error:', response.status, errorText);
      
      // Decrement rate limit on API failure (don't count failed attempts)
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
        return res.status(500).json({ error: 'Audio processing failed. Please try again.' });
      }
    }

    // Get the processed audio
    const audioBuffer = await response.buffer();
    
    // Set appropriate headers for audio download
    const fileExtension = getFileExtension(file.originalname);
    const filename = `${getBaseName(file.originalname)}_no_${stem}.${fileExtension}`;
    
    res.setHeader('Content-Type', 'audio/mpeg'); // Always return MP3 for simplicity
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', audioBuffer.length);
    
    // Send the processed audio file
    res.send(audioBuffer);

  } catch (error) {
    console.error('API error:', error);
    res.status(500).json({ 
      error: 'Processing failed',
      message: error.message || 'Please try again'
    });
  }
}

// Estimate audio duration based on file size (rough approximation)
function estimateDuration(file) {
  const sizeInMB = file.size / (1024 * 1024);
  // Rough estimate: MP3 is ~1MB per minute at 128kbps
  // WAV is ~10MB per minute at 44.1kHz/16bit stereo
  // Use conservative estimate based on file type
  
  if (file.mimetype === 'audio/wav') {
    return sizeInMB * 6; // ~6 seconds per MB for WAV
  } else {
    return sizeInMB * 60; // ~60 seconds per MB for compressed audio
  }
}

// Helper functions
function getFileExtension(filename) {
  return filename.split('.').pop().toLowerCase();
}

function getBaseName(filename) {
  return filename.replace(/\.[^/.]+$/, '');
}

// Helper functions
function getFileExtension(filename) {
  return filename.split('.').pop().toLowerCase();
}

function getBaseName(filename) {
  return filename.replace(/\.[^/.]+$/, '');
}

function getMimeType(extension) {
  const mimeTypes = {
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'flac': 'audio/flac',
    'm4a': 'audio/m4a',
    'ogg': 'audio/ogg'
  };
  return mimeTypes[extension] || 'audio/mpeg';
}

// Alternative Express.js version for traditional hosting
export function expressHandler(app) {
  app.post('/api/separate', upload.single('file'), async (req, res) => {
    try {
      const { file } = req;
      const { stem } = req.body;

      if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      // Create form data for LALAL.AI
      const formData = new FormData();
      formData.append('file', file.buffer, {
        filename: file.originalname,
        contentType: file.mimetype
      });
      formData.append('stem', stem);
      formData.append('filter', '1');

      // Call LALAL.AI
      const response = await fetch(LALAL_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${LALAL_API_KEY}`,
          ...formData.getHeaders()
        },
        body: formData
      });

      if (!response.ok) {
        throw new Error(`LALAL.AI API error: ${response.status}`);
      }

      const audioBuffer = await response.buffer();
      const fileExtension = getFileExtension(file.originalname);
      const filename = `${getBaseName(file.originalname)}_no_${stem}.${fileExtension}`;
      
      res.setHeader('Content-Type', getMimeType(fileExtension));
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(audioBuffer);

    } catch (error) {
      console.error('Processing error:', error);
      res.status(500).json({ error: 'Processing failed' });
    }
  });
}

// Environment variables needed:
// LALAL_API_KEY=your_activation_key_here

// Package.json dependencies:
/*
{
  "dependencies": {
    "node-fetch": "^2.6.7",
    "form-data": "^4.0.0",
    "multer": "^1.4.5"
  }
}
*/
