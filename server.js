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

// Meta Ad Library search
app.post('/api/meta-ads', async (req, res) => {
  try {
    const { keywords, countries } = req.body;
    const token = META_TOKEN;
    const countriesParam = (countries || ['MX','CO','AR','ES','PE','VE','CL','EC','GT','BO']).join(',');
    const searchTerms = encodeURIComponent(keywords);
    const path = `/v19.0/ads_archive?access_token=${token}&search_terms=${searchTerms}&ad_reached_countries=[${countriesParam.split(',').map(c=>`"${c}"`).join(',')}]&ad_type=ALL&media_type=VIDEO&fields=id,ad_creative_bodies,ad_creative_link_captions,ad_creative_link_descriptions,ad_creative_link_titles,ad_delivery_start_time,ad_snapshot_url,page_name,impressions,spend&limit=20&ad_active_status=ALL`;
    
    const result = await makeRequest('graph.facebook.com', path, 'GET', {}, null);
    res.status(result.status).json(JSON.parse(result.body));
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
    
    const tmpDir = os.tmpdir();
    const hookFile = path.join(tmpDir, `hook_${Date.now()}.mp4`);
    const winnerFile = path.join(tmpDir, `winner_${Date.now()}.mp4`);
    const outputFile = path.join(tmpDir, `merged_${Date.now()}.mp4`);
    const trimmedWinner = path.join(tmpDir, `trimmed_${Date.now()}.mp4`);

    // Write files
    fs.writeFileSync(hookFile, Buffer.from(hookBase64, 'base64'));
    fs.writeFileSync(winnerFile, Buffer.from(winnerBase64, 'base64'));

    // Get winner duration
    const duration = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${winnerFile}"`).toString().trim();
    const winnerDuration = parseFloat(duration);
    
    // Trim hook to hookDuration seconds
    const trimmedHook = path.join(tmpDir, `trimhook_${Date.now()}.mp4`);
    execSync(`"${ffmpegPath}" -i "${hookFile}" -t ${hookDuration} -c:v libx264 -c:a aac "${trimmedHook}" -y`);
    
    // Trim winner removing first hookDuration seconds
    execSync(`"${ffmpegPath}" -i "${winnerFile}" -ss ${hookDuration} -c:v libx264 -c:a aac "${trimmedWinner}" -y`);
    
    // Create concat list
    const listFile = path.join(tmpDir, `list_${Date.now()}.txt`);
    fs.writeFileSync(listFile, `file '${trimmedHook}'\nfile '${trimmedWinner}'`);
    
    // Concatenate
    execSync(`"${ffmpegPath}" -f concat -safe 0 -i "${listFile}" -c copy "${outputFile}" -y`);
    
    const merged = fs.readFileSync(outputFile);
    
    // Cleanup
    [hookFile, winnerFile, outputFile, trimmedWinner, trimmedHook, listFile].forEach(f => {
      try { fs.unlinkSync(f); } catch(e) {}
    });
    
    res.json({ video: merged.toString('base64') });
  } catch(e) { 
    res.status(500).json({ error: e.message }); 
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HookAI running on port ${PORT}`));
