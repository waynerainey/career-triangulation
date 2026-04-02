'use strict';

const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

// pdf-parse can hang indefinitely on certain PDFs (complex structure, corrupt
// xref tables, encrypted content). A hard Promise.race timeout ensures it
// never blocks the serverless function for the full Lambda execution window.
const PDF_TIMEOUT_MS = 10000;

function looksLikeLinkedIn(text) {
  const markers = ['linkedin', 'experience', 'education', 'skills', 'summary'];
  const lower = text.toLowerCase();
  const matches = markers.filter(m => lower.includes(m));
  return matches.length >= 2;
}

async function extractText(buffer, mimetype, originalname) {
  const ext = (originalname || '').toLowerCase().split('.').pop();
  let extractedText = '';

  if (mimetype === 'application/pdf' || ext === 'pdf') {
    console.log('[fileParser] PDF start:', originalname, buffer.length, 'bytes');

    const timeoutPromise = new Promise((_resolve, reject) =>
      setTimeout(
        () => reject(new Error(`pdf-parse timed out after ${PDF_TIMEOUT_MS / 1000}s on "${originalname}"`)),
        PDF_TIMEOUT_MS,
      )
    );

    try {
      const data = await Promise.race([pdfParse(buffer), timeoutPromise]);
      console.log('[fileParser] PDF done:', originalname, data.text.length, 'chars extracted');
      extractedText = data.text;
    } catch (err) {
      // Log and continue — caller validates whether enough text was obtained.
      console.error('[fileParser] PDF failed:', originalname, '—', err.message);
      return '';
    }
  } else if (
    mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  ) {
    console.log('[fileParser] DOCX start:', originalname, buffer.length, 'bytes');
    const result = await mammoth.extractRawText({ buffer });
    console.log('[fileParser] DOCX done:', originalname, result.value.length, 'chars extracted');
    extractedText = result.value;
  } else {
    // Plain text
    extractedText = buffer.toString('utf8');
    console.log('[fileParser] text done:', originalname, extractedText.length, 'chars');
  }

  // Prompt injection scan — detect adversarial instructions embedded in the
  // uploaded document before it reaches the LLM.
  const INJECTION_PATTERNS = [
    'ignore previous instructions',
    'ignore all instructions',
    'you are now',
    'disregard',
    'new task',
    'system prompt',
    'forget your instructions',
    'new instructions',
  ];
  const lowerText = extractedText.toLowerCase();
  const injectionHit = INJECTION_PATTERNS.find(p => lowerText.includes(p));
  if (injectionHit) {
    console.warn('[fileParser] injection pattern detected:', injectionHit);
    throw Object.assign(
      new Error('This document could not be processed. Please upload a standard LinkedIn PDF export.'),
      { code: 'INJECTION_DETECTED' }
    );
  }

  if (!looksLikeLinkedIn(extractedText)) {
    throw Object.assign(
      new Error('Document does not appear to be a LinkedIn profile export. Please upload your LinkedIn PDF and try again.'),
      { code: 'NOT_LINKEDIN' }
    );
  }

  return extractedText;
}

module.exports = { extractText };
