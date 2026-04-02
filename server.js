'use strict';

const https = require('https');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const path = require('path');

const { SYSTEM_PROMPT, buildUserPrompt, parseAnalysisResponse } = require('./prompt');
const { extractText } = require('./fileParser');
const { generatePDF, buildFilename } = require('./pdfGenerator');

const app = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Memory storage — stateless, no disk writes
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter(req, file, cb) {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(file.mimetype) || ['.pdf', '.docx', '.txt'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

// ── RATE LIMITER ──────────────────────────────────────────────────────────────
// In-memory store: maps hashed IP → { count, windowStart }
// 5 requests per IP per rolling hour. No external dependencies.
const rateLimitStore = new Map();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function getRateLimitKey(req) {
  const raw = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.ip
    || req.socket?.remoteAddress
    || 'unknown';
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function checkRateLimit(req, res) {
  const key = getRateLimitKey(req);
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(key, { count: 1, windowStart: now });
    return false; // not limited
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    console.warn('[rate-limit] exceeded — ip_hash:', key);
    res.status(429).json({
      error: 'rate_limit_exceeded',
      message: 'You have reached the limit for this hour. Please try again later.',
    });
    return true; // limited
  }

  entry.count += 1;
  return false; // not limited
}

// ── ANALYZE ENDPOINT ──────────────────────────────────────────────────────────
app.post(
  '/api/analyze',
  upload.fields([
    { name: 'linkedin', maxCount: 1 },
  ]),
  async (req, res) => {
    if (checkRateLimit(req, res)) return;
    let abortTimeout; // hoisted so catch can clearTimeout even on early errors
    try {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey || apiKey === 'your_key_here') {
        return res.status(503).json({
          error: 'api_key_missing',
          message: 'No API key configured. Add your Anthropic API key to the .env file.',
        });
      }

      const files = req.files || {};

      // Extract text from LinkedIn PDF
      let linkedinText = null;

      if (files.linkedin?.[0]) {
        const f = files.linkedin[0];
        linkedinText = await extractText(f.buffer, f.mimetype, f.originalname);
        console.log('[analyze] linkedin extracted, length:', linkedinText?.length ?? 0);
        // LinkedIn PDFs can be 30k–50k+ chars. System prompt alone is ~11.7k chars
        // (~2.9k tokens), leaving a tight input budget. At 6k LinkedIn input
        // (~4.5k tokens total) Haiku consistently exceeds the 22s abort. Dropping
        // to 4k LinkedIn input (~3.9k tokens total) brings generation time back
        // within range. 4k chars covers headline, About, and top 1-2 roles —
        // the sections that actually drive discoverability and categorization signal.
        const MAX_LINKEDIN_CHARS = 4000;
        if (linkedinText && linkedinText.length > MAX_LINKEDIN_CHARS) {
          linkedinText = linkedinText.substring(0, MAX_LINKEDIN_CHARS);
          console.log('[analyze] linkedin truncated to', MAX_LINKEDIN_CHARS, 'chars');
        }
      }

      if (!linkedinText) {
        return res.status(400).json({
          error: 'no_documents',
          message: 'Please upload your LinkedIn PDF to analyze.',
        });
      }

      const userPrompt = buildUserPrompt({ linkedinText });

      console.log('[analyze] prompt length:', userPrompt.length, 'chars, type:', typeof userPrompt);

      // stream: true causes the API to send HTTP response headers + SSE token
      // events immediately as generation starts (~1-2s), rather than holding
      // the socket completely silent for the full generation time. This prevents
      // our 25s timeout from firing on long responses.
      const requestBody = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        stream: true,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const apiCallStart = Date.now();
      const { apiStatus, rawText } = await new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            agent: false, // fresh socket, no undici pool
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(requestBody),
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
          },
          (res) => {
            const status = res.statusCode;
            console.log('[analyze] response headers received in', Date.now() - apiCallStart, 'ms, status:', status);
            let textAccum = '';
            let rawBody = '';
            let sseBuffer = '';
            let firstChunk = true;

            res.on('data', (chunk) => {
              if (firstChunk) {
                console.log('[analyze] first chunk received in', Date.now() - apiCallStart, 'ms, status:', status);
                firstChunk = false;
              }

              if (status !== 200) {
                rawBody += chunk;
                return;
              }

              // Parse SSE: messages are separated by \n\n; each has a data: line.
              sseBuffer += chunk.toString();
              const parts = sseBuffer.split('\n\n');
              sseBuffer = parts.pop(); // keep incomplete trailing segment

              for (const part of parts) {
                let dataLine = '';
                for (const line of part.split('\n')) {
                  if (line.startsWith('data: ')) dataLine = line.slice(6);
                }
                if (!dataLine || dataLine === '[DONE]') continue;
                try {
                  const evt = JSON.parse(dataLine);
                  if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
                    textAccum += evt.delta.text;
                  }
                } catch (_) { /* skip non-JSON lines */ }
              }
            });

            res.on('end', () => {
              clearTimeout(abortTimeout);
              if (status !== 200) {
                try {
                  const errData = JSON.parse(rawBody);
                  const e = new Error(errData.error?.message || `API error ${status}`);
                  e.status = status;
                  reject(e);
                } catch (_) {
                  const e = new Error(`API error ${status}`);
                  e.status = status;
                  reject(e);
                }
                return;
              }
              resolve({ apiStatus: status, rawText: textAccum });
            });
          },
        );

        abortTimeout = setTimeout(() => {
          req.destroy();
          reject(Object.assign(new Error('Analysis timed out. Try a shorter document or try again.'), { isTimeout: true }));
        }, 22000);

        req.on('error', (err) => {
          clearTimeout(abortTimeout);
          reject(err);
        });

        console.log('[analyze] sending request body,', requestBody.length, 'chars');
        req.write(requestBody);
        req.end();
      });

      console.log('[analyze] Anthropic streaming resolved in', Date.now() - apiCallStart, 'ms, status:', apiStatus);
      const findings = parseAnalysisResponse(rawText);

      // Schema validation — catch hijacked or off-schema responses
      const requiredKeys = ['framing', 'patternSummary', 'telescope', 'microscope', 'mirror', 'economicNote'];
      const missingKeys = requiredKeys.filter(k => !(k in findings));
      if (missingKeys.length > 0) {
        if (findings.error === 'invalid_document') {
          return res.status(400).json({ error: 'invalid_document', message: findings.message });
        }
        if (findings.error === 'parse_failed') {
          return res.status(500).json({ error: 'analysis_failed', message: 'Analysis produced an unexpected result. Please try again.' });
        }
        return res.status(500).json({ error: 'analysis_failed', message: 'Analysis produced an unexpected result. Please try again.' });
      }

      // Attach session metadata (not stored)
      findings._session = {
        date: new Date().toISOString(),
      };

      res.json({ success: true, findings });
    } catch (err) {
      clearTimeout(abortTimeout);
      console.error('[analyze] caught error:', {
        name:    err.name,
        message: err.message,
        status:  err.status,
        code:    err.code,
        cause:   err.cause?.message,
        stack:   err.stack,
      });
      // Injection pattern detected in uploaded document.
      if (err.code === 'INJECTION_DETECTED') {
        return res.status(400).json({ error: 'invalid_document', message: err.message });
      }
      // Non-LinkedIn document rejected by fileParser structural check.
      if (err.code === 'NOT_LINKEDIN') {
        return res.status(400).json({ error: 'invalid_document', message: err.message });
      }
      if (err.isTimeout || err.name === 'AbortError' || err.name === 'APIUserAbortError' || err.message?.includes('timed out') || err.name === 'APITimeoutError' || err.code === 'ETIMEDOUT') {
        return res.status(504).json({ error: 'api_timeout', message: 'Analysis timed out. Try a shorter document or try again.' });
      }
      if (err.status === 401) {
        return res.status(401).json({ error: 'auth_failed', message: 'Invalid API key.' });
      }
      if (err.status === 429) {
        return res.status(429).json({ error: 'rate_limit', message: 'Rate limit reached. Please wait a moment and try again.' });
      }
      res.status(500).json({ error: 'analysis_failed', message: err.message || 'Analysis failed. Please try again.' });
    }
  }
);

// ── PING ENDPOINT ─────────────────────────────────────────────────────────────
// Connectivity test: raw https.get to api.anthropic.com — bypasses the SDK
// entirely so we can tell whether the network layer is reachable.
app.get('/api/ping', (_req, res) => {
  const target = 'https://api.anthropic.com';
  console.log('[ping] starting raw https.get to', target);
  const startMs = Date.now();

  const req = https.get(target, (response) => {
    const elapsed = Date.now() - startMs;
    console.log('[ping] connected — HTTP status:', response.statusCode, 'elapsed:', elapsed, 'ms');
    response.resume(); // drain so the socket closes cleanly
    res.json({ ok: true, status: response.statusCode, elapsed_ms: elapsed, target });
  });

  req.setTimeout(10000, () => {
    const elapsed = Date.now() - startMs;
    console.error('[ping] TIMEOUT after', elapsed, 'ms — cannot reach', target);
    req.destroy();
    res.status(504).json({ ok: false, error: 'timeout', elapsed_ms: elapsed, target });
  });

  req.on('error', (err) => {
    const elapsed = Date.now() - startMs;
    console.error('[ping] ERROR after', elapsed, 'ms —', err.message, err.code);
    res.status(502).json({ ok: false, error: err.message, code: err.code, elapsed_ms: elapsed, target });
  });
});

// ── PDF ENDPOINT ──────────────────────────────────────────────────────────────
app.post('/api/pdf', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const { findings, session } = req.body;
    if (!findings) return res.status(400).json({ error: 'no_findings', message: 'No findings provided.' });

    const pdfBuffer = await generatePDF(findings, session || {});
    const filename = buildFilename(session?.date ? new Date(session.date) : null);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('PDF error:', err);
    res.status(500).json({ error: 'pdf_failed', message: err.message || 'PDF generation failed.' });
  }
});

// ── START ─────────────────────────────────────────────────────────────────────
// Only start the HTTP server when run directly (local dev).
// When imported by netlify/functions/api.js, the app is exported and wrapped
// by serverless-http — no listen() call is needed there.
if (require.main === module) {
  require('dotenv').config();
  app.listen(PORT, () => {
    console.log(`Career Triangulation running at http://localhost:${PORT}`);
  });
}

module.exports = app;
