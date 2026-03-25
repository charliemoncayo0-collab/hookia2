const express = require('express');
const cors = require('cors');
const https = require('https');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const CLAUDE_KEY = process.env.CLAUDE_KEY || '';
const HEYGEN_KEY = process.env.HEYGEN_KEY || '';

function makeRequest(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname, path, method,
      headers: { 'Content-Type': 'application/json', ...headers }
    };
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

app.post('/api/claude', async (req, res) => {
  try {
    const result = await makeRequest(
      'api.anthropic.com', '/v1/messages', 'POST',
      { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      req.body
    );
    res.status(result.status).json(JSON.parse(result.body));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/heygen', async (req, res) => {
  try {
    const { endpoint, body, method = 'POST' } = req.body;
    const result = await makeRequest(
      'api.heygen.com', endpoint, method,
      { 'X-Api-Key': HEYGEN_KEY },
      body
    );
    res.status(result.status).json(JSON.parse(result.body));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HookAI running on port ${PORT}`));
