const express = require('express');
const axios = require('axios');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const morgan = require('morgan');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || 'local-dev-key-123'; // match n8n header

const PUBLIC_DIR = path.join(__dirname, 'public');
const TMP_DIR = path.join(__dirname, 'tmp');

if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR);
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

app.use(express.json({ limit: '20mb' }));
app.use(morgan('dev'));

// Serve static files so n8n can access them
app.use('/files', express.static(PUBLIC_DIR));

// Simple API key check using x-api-key header
app.use((req, res, next) => {
  const key = req.header('x-api-key');
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, (error, stdout, stderr) => {
      if (error) {
        console.error('ffmpeg error:', error, stderr);
        return reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}

function runFfprobe(filePath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      filePath
    ], (error, stdout) => {
      if (error) {
        console.error('ffprobe error:', error);
        return reject(error);
      }
      try {
        const data = JSON.parse(stdout);
        const duration = parseFloat(data.format.duration || '0');
        resolve(duration);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function downloadToTemp(url, prefix) {
  const id = crypto.randomBytes(8).toString('hex');
  const ext = path.extname(new URL(url).pathname) || '.bin';
  const tempPath = path.join(TMP_DIR, `${prefix}-${id}${ext}`);

  const writer = fs.createWriteStream(tempPath);
  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
  });

  return new Promise((resolve, reject) => {
    response.data.pipe(writer);
    writer.on('finish', () => resolve(tempPath));
    writer.on('error', reject);
  });
}

function makePublicPath(prefix, ext = '.mp4') {
  const id = crypto.randomBytes(8).toString('hex');
  const fileName = `${prefix}-${id}${ext}`;
  return {
    abs: path.join(PUBLIC_DIR, fileName),
    rel: `/files/${fileName}`,
  };
}

// 1) image -> motion video
app.post('/v1/image/convert/video', async (req, res) => {
  try {
    const { image_url, length, frame_rate, zoom_speed, id } = req.body;

    if (!image_url) {
      return res.status(400).json({ error: 'image_url is required' });
    }

    const videoLength = Number(length) || 20;
    const fps = Number(frame_rate) || 25;

    const imagePath = await downloadToTemp(image_url, 'image');
    const { abs: outPath, rel: relPath } = makePublicPath('scene', '.mp4');

    const filter = [
      `zoompan=z='min(zoom+0.0008,1.3)':d=${fps}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
      `scale=1080:1920`,
      `framerate=${fps}`
    ].join(',');

    const args = [
      '-loop', '1',
      '-i', imagePath,
      '-t', String(videoLength),
      '-vf', filter,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      outPath,
    ];

    await runFfmpeg(args);

    const baseUrl = getBaseUrl(req);
    const fileUrl = `${baseUrl}${relPath}`;

    res.json({
      response: fileUrl,
      id: id || null,
    });
  } catch (err) {
    console.error('image/convert/video error', err);
    res.status(500).json({ error: 'Failed to create video from image' });
  }
});

// 2) media metadata
app.post('/v1/media/metadata', async (req, res) => {
  try {
    const { media_url } = req.body;
    if (!media_url) {
      return res.status(400).json({ error: 'media_url is required' });
    }

    const audioPath = await downloadToTemp(media_url, 'audio-meta');
    const duration = await runFfprobe(audioPath);

    const totalSeconds = Math.round(duration);
    const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const s = String(totalSeconds % 60).padStart(2, '0');
    const formatted = `${h}:${m}:${s}`;

    res.json({
      duration,
      duration_formatted: formatted,
    });
  } catch (err) {
    console.error('media/metadata error', err);
    res.status(500).json({ error: 'Failed to get media metadata' });
  }
});

// 3) trim video
app.post('/v1/video/trim', async (req, res) => {
  try {
    const { video_url, start, end } = req.body;
    if (!video_url) {
      return res.status(400).json({ error: 'video_url is required' });
    }

    const videoPath = await downloadToTemp(video_url, 'trim-in');
    const { abs: outPath, rel: relPath } = makePublicPath('trim-out', '.mp4');

    const args = [
      '-ss', start || '00:00:00',
      ...(end ? ['-to', end] : []),
      '-i', videoPath,
      '-c', 'copy',
      outPath,
    ];

    await runFfmpeg(args);

    const baseUrl = getBaseUrl(req);
    const fileUrl = `${baseUrl}${relPath}`;

    res.json({
      response: fileUrl,
    });
  } catch (err) {
    console.error('video/trim error', err);
    res.status(500).json({ error: 'Failed to trim video' });
  }
});

// 4) compose video + audio
app.post('/v1/ffmpeg/compose', async (req, res) => {
  try {
    const { inputs } = req.body;
    if (!Array.isArray(inputs) || inputs.length < 2) {
      return res.status(400).json({ error: 'inputs[video, audio] required' });
    }

    const videoInput = inputs[0].file_url;
    const audioInput = inputs[1].file_url;
    if (!videoInput || !audioInput) {
      return res.status(400).json({ error: 'file_url missing in inputs' });
    }

    const videoPath = await downloadToTemp(videoInput, 'compose-video');
    const audioPath = await downloadToTemp(audioInput, 'compose-audio');
    const { abs: outPath, rel: relPath } = makePublicPath('compose-out', '.mp4');

    const args = [
      '-i', videoPath,
      '-i', audioPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-shortest',
      outPath
    ];

    await runFfmpeg(args);

    const baseUrl = getBaseUrl(req);
    const fileUrl = `${baseUrl}${relPath}`;

    res.json({
      response: fileUrl,
    });
  } catch (err) {
    console.error('ffmpeg/compose error', err);
    res.status(500).json({ error: 'Failed to compose audio+video' });
  }
});

// 5) concatenate scenes
app.post('/v1/video/concatenate', async (req, res) => {
  try {
    const { video_urls, id } = req.body;
    if (!Array.isArray(video_urls) || video_urls.length === 0) {
      return res.status(400).json({ error: 'video_urls must be non-empty array' });
    }

    const tempListPath = path.join(TMP_DIR, `concat-${crypto.randomBytes(8).toString('hex')}.txt`);

    const localPaths = [];
    for (const item of video_urls) {
      const url = item.video_url || item;
      if (!url) continue;
      const p = await downloadToTemp(url, 'concat');
      localPaths.push(p);
    }

    if (localPaths.length === 0) {
      return res.status(400).json({ error: 'No valid video URLs' });
    }

    const listContent = localPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    await fsp.writeFile(tempListPath, listContent, 'utf8');

    const { abs: outPath, rel: relPath } = makePublicPath(id ? `concat-${id}` : 'concat-out', '.mp4');

    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-i', tempListPath,
      '-c', 'copy',
      outPath
    ];

    await runFfmpeg(args);

    const baseUrl = getBaseUrl(req);
    const fileUrl = `${baseUrl}${relPath}`;

    res.json({
      response: fileUrl,
      id: id || null,
    });
  } catch (err) {
    console.error('video/concatenate error', err);
    res.status(500).json({ error: 'Failed to concatenate videos' });
  }
});

// 6) caption stub
app.post('/v1/video/caption', async (req, res) => {
  try {
    const { video_url, id } = req.body;
    if (!video_url) {
      return res.status(400).json({ error: 'video_url is required' });
    }

    res.json({
      response: video_url,
      id: id || null,
      note: 'Captioning stub: extend later if needed.'
    });
  } catch (err) {
    console.error('video/caption error', err);
    res.status(500).json({ error: 'Failed in caption stub' });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Video backend running' });
});

app.listen(PORT, () => {
  console.log(`Video backend listening on port ${PORT}`);
});
