const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const path = require('path');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const ffmpegPath = require('ffmpeg-static');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const CLAUDE_KEY = process.env.CLAUDE_KEY || '';
const HEYGEN_KEY = process.env.HEYGEN_KEY || '';
const FAL_KEY = process.env.FAL_KEY || '';
const META_TOKEN = process.env.META_TOKEN || '';

function makeRequest(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = { hostname, path, method, headers: { 'Content-Type': 'application/json', ...headers } };
    if (data) options.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: responseData }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Claude proxy
app.post('/api/claude', async (req, res) => {
  try {
    const result = await makeRequest('api.anthropic.com', '/v1/messages', 'POST',
      { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' }, req.body);
    res.status(result.status).json(JSON.parse(result.body));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// HeyGen proxy
app.post('/api/heygen', async (req, res) => {
  try {
    const { endpoint, body, method = 'POST' } = req.body;
    const result = await makeRequest('api.heygen.com', endpoint, method,
      { 'X-Api-Key': HEYGEN_KEY }, body);
    res.status(result.status).json(JSON.parse(result.body));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// FAL proxy
app.post('/api/fal', async (req, res) => {
  try {
    const { endpoint, body } = req.body;
    const result = await makeRequest('fal.run', endpoint, 'POST',
      { 'Authorization': `Key ${FAL_KEY}` }, body);
    res.status(result.status).json(JSON.parse(result.body));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fal-status', async (req, res) => {
  try {
    const { request_id, endpoint } = req.body;
    const result = await makeRequest('fal.run', `/${endpoint}/requests/${request_id}`, 'GET',
      { 'Authorization': `Key ${FAL_KEY}` }, null);
    res.status(result.status).json(JSON.parse(result.body));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Google Custom Search for TikTok videos
app.post('/api/meta-ads', async (req, res) => {
  try {
    const { keywords } = req.body;
    const GOOGLE_KEY = process.env.GOOGLE_API_KEY || '';
    const CSE_ID = process.env.GOOGLE_CSE_ID || '';
    const query = encodeURIComponent(keywords + ' site:tiktok.com');
    const path = `/customsearch/v1?key=${GOOGLE_KEY}&cx=${CSE_ID}&q=${query}&num=10&searchType=video`;
    
    const result = await makeRequest('www.googleapis.com', path, 'GET', {}, null);
    const data = JSON.parse(result.body);
    
    // Transform Google results to match our expected format
    const items = (data.items || []).map((item, i) => ({
      id: i,
      page_name: item.displayLink || 'TikTok',
      ad_creative_link_titles: [item.title],
      ad_creative_bodies: [item.snippet],
      ad_snapshot_url: item.link,
      video_url: item.link
    }));
    
    res.json({ data: items });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Download video from URL
app.post('/api/download-video', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    // Download the video
    const tmpFile = path.join(os.tmpdir(), `vid_${Date.now()}.mp4`);
    
    await new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      const file = fs.createWriteStream(tmpFile);
      protocol.get(url, (response) => {
        response.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', reject);
    });

    res.download(tmpFile, 'ad_video.mp4', () => {
      fs.unlink(tmpFile, () => {});
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Merge videos: replace hook of winning video with downloaded hook
app.post('/api/merge-videos', async (req, res) => {
  try {
    const { hookBase64, winnerBase64, hookDuration = 5 } = req.body;
    
    const ts = Date.now();
    const tmpDir = os.tmpdir();
    const hookFile = path.join(tmpDir, `hook_${ts}.mp4`);
    const winnerFile = path.join(tmpDir, `winner_${ts}.mp4`);
    const trimmedHook = path.join(tmpDir, `trimhook_${ts}.mp4`);
    const trimmedWinner = path.join(tmpDir, `trimwinner_${ts}.mp4`);
    const outputFile = path.join(tmpDir, `merged_${ts}.mp4`);
    const listFile = path.join(tmpDir, `list_${ts}.txt`);

    // Write files
    fs.writeFileSync(hookFile, Buffer.from(hookBase64, 'base64'));
    fs.writeFileSync(winnerFile, Buffer.from(winnerBase64, 'base64'));

    // Normalize hook to small format for low memory
    execSync(`"${ffmpegPath}" -i "${hookFile}" -t ${hookDuration} -vf "scale=480:854:force_original_aspect_ratio=decrease,pad=480:854:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24" -c:v libx264 -preset ultrafast -crf 30 -c:a aac -ar 44100 -ac 1 "${trimmedHook}" -y`, {timeout: 180000});
    fs.unlinkSync(hookFile);

    // Normalize winner body
    execSync(`"${ffmpegPath}" -ss ${hookDuration} -i "${winnerFile}" -vf "scale=480:854:force_original_aspect_ratio=decrease,pad=480:854:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24" -c:v libx264 -preset ultrafast -crf 30 -c:a aac -ar 44100 -ac 1 "${trimmedWinner}" -y`, {timeout: 180000});
    fs.unlinkSync(winnerFile);

    // Concat
    fs.writeFileSync(listFile, `file '${trimmedHook}'\nfile '${trimmedWinner}'`);
    execSync(`"${ffmpegPath}" -f concat -safe 0 -i "${listFile}" -c copy "${outputFile}" -y`, {timeout: 60000});
    fs.unlinkSync(trimmedHook); fs.unlinkSync(trimmedWinner); fs.unlinkSync(listFile);

    const merged = fs.readFileSync(outputFile);

    [hookFile, winnerFile, trimmedHook, trimmedWinner, outputFile, listFile].forEach(f => {
      try { fs.unlinkSync(f); } catch(e) {}
    });

    res.json({ video: merged.toString('base64') });
  } catch(e) { 
    console.error('Merge error:', e.message);
    res.status(500).json({ error: e.message }); 
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HookAI running on port ${PORT}`));
