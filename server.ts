import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { GoogleGenAI, FileState } from '@google/genai';
import cors from 'cors';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
// Serve static files from uploads directory
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR);
}

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = uuidv4();
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  },
});
const upload = multer({ storage });

// Helper: Wait for file to be active
async function waitForFileActive(fileId: string) {
  console.log(`Waiting for file ${fileId} to be active...`);
  let file = await ai.files.get({ name: fileId });
  while (file.state === FileState.PROCESSING) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    file = await ai.files.get({ name: fileId });
  }
  if (file.state !== FileState.ACTIVE) {
    throw new Error(`File ${file.name} failed to process. State: ${file.state}`);
  }
  console.log(`File ${fileId} is active.`);
  return file;
}

// API Routes

// 1. Upload File
app.post('/api/upload', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const mimeType = req.file.mimetype;

    console.log(`Uploading file to Gemini: ${filePath}`);
    
    // Upload to Gemini
    const uploadResult = await ai.files.upload({
      file: new Blob([fs.readFileSync(filePath)]),
      config: {
        mimeType: mimeType,
        displayName: req.file.originalname,
      }
    });

    // Keep local file for trimming/downloading later
    // fs.unlinkSync(filePath); 

    res.json({ 
      fileId: uploadResult.name, 
      uri: uploadResult.uri,
      state: uploadResult.state,
      localFilename: req.file.filename
    });

  } catch (error: any) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Process URL (Download -> Upload to Gemini)
app.post('/api/process-url', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    // Basic validation
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      return res.status(400).json({ error: 'YouTube downloads are not supported in this demo. Please use a direct video link (mp4/webm) or upload a file.' });
    }

    const filename = `url-upload-${uuidv4()}.mp4`;
    const filePath = path.join(UPLOADS_DIR, filename);

    console.log(`Downloading from URL: ${url}`);
    
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch URL: ${response.statusText}`);
    
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(buffer));

    console.log(`Downloaded to ${filePath}, uploading to Gemini...`);

    const uploadResult = await ai.files.upload({
      file: new Blob([fs.readFileSync(filePath)]),
      config: {
        mimeType: 'video/mp4', // Assuming mp4 for URL downloads for simplicity, or detect from headers
        displayName: filename,
      }
    });

    // Keep local file for trimming/downloading later
    // fs.unlinkSync(filePath);

    res.json({ 
      fileId: uploadResult.name, 
      uri: uploadResult.uri,
      state: uploadResult.state,
      localFilename: filename
    });

  } catch (error: any) {
    console.error('URL processing error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper: Get file status
app.get('/api/file-status', async (req, res) => {
  try {
    const { fileId } = req.query;
    if (!fileId) return res.status(400).json({ error: 'fileId is required' });

    const file = await ai.files.get({ name: fileId as string });
    res.json({ state: file.state });
  } catch (error: any) {
    console.error('File status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Analyze Video
app.post('/api/analyze', async (req, res) => {
  try {
    const { fileId, preferences } = req.body;
    if (!fileId) return res.status(400).json({ error: 'fileId is required' });

    // Note: Client should now wait for file to be active before calling this, 
    // but we keep a safety check here just in case.
    const file = await ai.files.get({ name: fileId });
    if (file.state !== FileState.ACTIVE) {
       return res.status(400).json({ error: 'File is not ready for analysis yet.' });
    }

    // Generate Content
    console.log(`Analyzing file ${fileId} with preferences:`, preferences);
    const model = 'gemini-2.5-flash-latest';
    
    let styleInstruction = "Balance between engaging dialogue and visual interest.";
    if (preferences?.style === 'spoken') {
      styleInstruction = "Focus primarily on dialogue, key quotes, and spoken narrative.";
    } else if (preferences?.style === 'visual') {
      styleInstruction = "Focus primarily on visual action, movement, and interesting scenes, ignoring dialogue if necessary.";
    }

    let durationInstruction = "Keep clips concise and engaging.";
    if (preferences?.duration && preferences.duration !== 'auto') {
      durationInstruction = `Target a clip duration of approximately ${preferences.duration} seconds.`;
    }

    const prompt = `
      Analyze this video and identify 3-5 most engaging short clips suitable for social media (TikTok/Shorts).
      
      Preferences:
      - Style: ${styleInstruction}
      - Duration: ${durationInstruction}

      For each clip, provide:
      1. A catchy title.
      2. A brief description of why it's engaging.
      3. The start and end timestamps (in MM:SS format).
      4. A "virality score" from 1-10.
      
      Return the result as a JSON object with a "clips" array.
      Example format:
      {
        "clips": [
          {
            "title": "Funny Cat Jump",
            "description": "The cat attempts to jump but fails hilariously.",
            "startTime": "00:10",
            "endTime": "00:25",
            "viralityScore": 9
          }
        ]
      }
    `;

    const result = await ai.models.generateContent({
      model: model,
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: (await ai.files.get({ name: fileId })).uri, mimeType: 'video/mp4' } }, // Re-fetch to get URI if needed, or just construct it. Actually fileData needs fileUri.
            { text: prompt }
          ]
        }
      ],
      config: {
        responseMimeType: 'application/json'
      }
    });

    const responseText = result.text;
    console.log('Analysis complete:', responseText);
    
    let jsonResponse;
    try {
      const cleanJson = responseText.replace(/```json\n|\n```/g, '').replace(/```/g, '');
      jsonResponse = JSON.parse(cleanJson);
    } catch (e) {
      console.error('Failed to parse JSON from Gemini:', e);
      // Fallback: return raw text if parsing fails, let frontend handle or show error
      return res.status(500).json({ error: 'Failed to parse AI response', raw: responseText });
    }

    res.json(jsonResponse);

  } catch (error: any) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. Download Clip (Trim Video)
app.get('/api/download-clip', (req, res) => {
  const { filename, startTime, endTime } = req.query;

  if (!filename || !startTime || !endTime) {
    return res.status(400).send('Missing required parameters: filename, startTime, endTime');
  }

  const inputPath = path.join(UPLOADS_DIR, filename as string);
  if (!fs.existsSync(inputPath)) {
    return res.status(404).send('Original video file not found');
  }

  // Convert MM:SS to seconds for ffmpeg (though ffmpeg accepts MM:SS too, but let's be safe)
  // Actually ffmpeg accepts HH:MM:SS or seconds. Let's just pass the string if it's MM:SS.
  // We might need to ensure it's in a format ffmpeg likes. 00:00 is fine.

  res.setHeader('Content-Disposition', `attachment; filename="clip-${filename}"`);
  res.setHeader('Content-Type', 'video/mp4');

  ffmpeg(inputPath)
    .setStartTime(startTime as string)
    .setDuration(calculateDuration(startTime as string, endTime as string))
    .outputOptions('-c copy') // Fast copy without re-encoding
    .format('mp4')
    .on('error', (err) => {
      console.error('Error trimming video:', err);
      if (!res.headersSent) {
        res.status(500).send('Error processing video');
      }
    })
    .pipe(res, { end: true });
});

function calculateDuration(start: string, end: string): number {
  const parse = (t: string) => {
    const parts = t.split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  };
  return parse(end) - parse(start);
}

// Vite Middleware
if (process.env.NODE_ENV !== 'production') {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
