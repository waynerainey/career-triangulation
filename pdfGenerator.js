'use strict';

const PDFDocument = require('pdfkit');

const COLORS = {
  ink:      '#1C1A17',
  cream:    '#F7F3ED',
  rust:     '#B85C38',
  gold:     '#C9A84C',
  sage:     '#5C7A6B',
  gray:     '#8A8178',
  border:   '#DDD8D0',
  cardBg:   '#FDFAF6',
  white:    '#FFFFFF',
};

function monthYear(date) {
  const d = date || new Date();
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function buildFilename(date) {
  const d = date || new Date();
  const month = d.toLocaleDateString('en-US', { month: 'long' });
  const year = d.getFullYear();
  return `CareerTriangulation_${month}${year}.pdf`;
}

function generatePDF(findings, session) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 54, bottom: 54, left: 60, right: 60 },
      info: {
        Title: 'Career Triangulation Report — The Career Cantina',
        Author: 'Career Triangulation',
        Subject: 'Telescope · Microscope · Mirror',
      },
    });

    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const L = doc.page.margins.left;

    // ── HEADER ────────────────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 72).fill(COLORS.ink);

    doc.fillColor(COLORS.gold)
      .font('Helvetica-Bold')
      .fontSize(20)
      .text('Career Triangulation Report', L, 16, { continued: false });

    doc.fillColor(COLORS.cream)
      .font('Helvetica')
      .fontSize(10)
      .text('Telescope \u00b7 Microscope \u00b7 Mirror', L, 42);

    doc.fillColor(COLORS.gold)
      .font('Helvetica-Bold')
      .fontSize(9)
      .text('The Career Cantina', L + W - 110, 28, { width: 110, align: 'right' });

    doc.fillColor(COLORS.gray)
      .font('Helvetica')
      .fontSize(8)
      .text(monthYear(session?.date ? new Date(session.date) : null), L + W - 110, 42, { width: 110, align: 'right' });

    doc.y = 92;

    // ── FRAMING ───────────────────────────────────────────────────────────
    // Gold left-border callout
    const framingText = findings.framing || '';
    const framingHeight = Math.max(40, doc.heightOfString(framingText, { width: W - 16 }) + 20);
    doc.rect(L, doc.y, 3, framingHeight).fill(COLORS.gold);
    doc.font('Helvetica-Oblique').fontSize(10).fillColor(COLORS.ink)
      .text(framingText, L + 14, doc.y + 10, { width: W - 16 });
    doc.y += framingHeight + 16;

    // ── PATTERN SUMMARY ───────────────────────────────────────────────────
    if (doc.y > doc.page.height - 120) doc.addPage();
    doc.rect(L, doc.y, W, 1).fill(COLORS.ink);
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.ink).text('Pattern Summary', L, doc.y);
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.ink)
      .text(findings.patternSummary || '', L, doc.y, { width: W });
    doc.moveDown(1.2);

    // ── LAYER HELPER ──────────────────────────────────────────────────────
    function renderLayer(key, label, accentColor) {
      const layer = findings[key];
      if (!layer) return;

      if (doc.y > doc.page.height - 180) doc.addPage();

      // Layer header bar
      doc.rect(L, doc.y, W, 1).fill(accentColor);
      doc.moveDown(0.5);

      doc.font('Helvetica-Bold').fontSize(13).fillColor(accentColor).text(label, L, doc.y);
      doc.moveDown(0.5);

      // Why paragraph
      if (layer.why) {
        doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(COLORS.gray)
          .text(layer.why, L, doc.y, { width: W });
        doc.moveDown(0.6);
      }

      // Questions
      const questions = Array.isArray(layer.questions) ? layer.questions : [];
      questions.forEach((q, i) => {
        if (doc.y > doc.page.height - 60) doc.addPage();
        const numLabel = `${i + 1}.`;
        doc.font('Helvetica-Bold').fontSize(8).fillColor(accentColor)
          .text(numLabel, L, doc.y, { continued: true, width: 18 });
        doc.font('Helvetica').fontSize(10).fillColor(COLORS.ink)
          .text(q, { width: W - 18 });
        doc.moveDown(0.5);
      });

      doc.moveDown(0.8);
    }

    renderLayer('telescope', 'Telescope', COLORS.rust);
    renderLayer('microscope', 'Microscope', COLORS.sage);
    renderLayer('mirror', 'Mirror', COLORS.gold);

    // ── ECONOMIC REALITY ──────────────────────────────────────────────────
    if (doc.y > doc.page.height - 80) doc.addPage();
    const econText = findings.economicNote || '';
    const econHeight = Math.max(40, doc.heightOfString(econText, { width: W - 16 }) + 20);
    doc.rect(L, doc.y, W, 1).fill(COLORS.border);
    doc.moveDown(0.5);
    doc.rect(L, doc.y, 3, econHeight).fill(COLORS.gray);
    doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(COLORS.gray)
      .text(econText, L + 14, doc.y + 10, { width: W - 16 });
    doc.y += econHeight + 16;

    // ── FOOTER ────────────────────────────────────────────────────────────
    const footerY = doc.page.height - 36;
    doc.rect(0, footerY, doc.page.width, 36).fill(COLORS.ink);
    doc.fillColor(COLORS.cream).font('Helvetica').fontSize(8)
      .text('The Career Cantina  \u00b7  Wayne Rainey  \u00b7  Career Triangulation Protocol', L, footerY + 12, { width: W, align: 'center' });

    doc.end();
  });
}

module.exports = { generatePDF, buildFilename };
