import express from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { v4 as uuid } from 'uuid';
import OpenAI from 'openai';
import PDFDocument from 'pdfkit';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3001);
const clientOrigins = parseOrigins(process.env.CLIENT_ORIGIN);

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: clientOrigins, credentials: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

const documentStore = new Map();

let openaiClient = null;
if (process.env.OPENAI_API_KEY) {
  openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Missing file upload' });
    }

    if (!req.file.originalname.toLowerCase().endsWith('.docx')) {
      return res.status(400).json({ error: 'Only .docx files are supported' });
    }

    const buffer = req.file.buffer;
    const docId = uuid();

    const previewResult = await mammoth.convertToHtml({ buffer });
    const previewHtml = previewResult.value;

    const zip = await JSZip.loadAsync(buffer);
    const xmlFile = zip.file('word/document.xml');
    if (!xmlFile) {
      return res.status(400).json({ error: 'Invalid .docx structure (missing document.xml)' });
    }

    const documentXml = await xmlFile.async('string');
    const { placeholders, metadata: placeholderMetadata, normalizedText } = await discoverPlaceholders(documentXml);

    documentStore.set(docId, {
      originalBuffer: buffer,
      previewHtml,
      placeholders,
      placeholderMetadata,
      normalizedText,
      questionState: null,
      filledBuffer: null,
      filledHtml: null,
      lastValues: {},
    });

    return res.json({
      docId,
      placeholders,
      previewHtml,
    });
  } catch (error) {
    console.error('Failed to process upload', error);
    return res.status(500).json({ error: 'Failed to process document upload' });
  }
});

app.post('/api/questionnaire/start', async (req, res) => {
  try {
    const { docId } = req.body || {};

    if (!docId) {
      return res.status(400).json({ error: 'docId is required' });
    }

    const storedDocument = documentStore.get(docId);
    if (!storedDocument) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const order = (storedDocument.placeholders ?? []).map((placeholder) => placeholder.id);
    const questionState = {
      order,
      currentIndex: 0,
      values: {},
      history: [],
      completed: false,
    };

    if (order.length === 0) {
      documentStore.set(docId, {
        ...storedDocument,
        questionState: { ...questionState, completed: true },
      });
      return res.json({ done: true, previewHtml: storedDocument.previewHtml });
    }

    const currentPlaceholderId = order[0];
    const question = await generateQuestionForPlaceholder(storedDocument, currentPlaceholderId);

    questionState.history.push({
      role: 'assistant',
      content: question,
      placeholderId: currentPlaceholderId,
    });

    documentStore.set(docId, {
      ...storedDocument,
      questionState,
    });

    return res.json({
      done: false,
      message: question,
      placeholderId: currentPlaceholderId,
    });
  } catch (error) {
    console.error('Questionnaire start error', error);
    return res.status(500).json({ error: 'Failed to start questionnaire' });
  }
});

app.post('/api/questionnaire/answer', async (req, res) => {
  try {
    const { docId, answer } = req.body || {};
    const trimmedAnswer = typeof answer === 'string' ? answer.trim() : '';

    if (!docId || !trimmedAnswer) {
      return res.status(400).json({ error: 'docId and a non-empty answer are required' });
    }

    const storedDocument = documentStore.get(docId);
    if (!storedDocument) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const state = storedDocument.questionState;
    if (!state || state.completed) {
      return res.status(400).json({ error: 'Questionnaire is not active for this document' });
    }

    const currentPlaceholderId = state.order[state.currentIndex];
    if (!currentPlaceholderId) {
      return res.status(400).json({ error: 'No active placeholder to answer' });
    }

    const updatedValues = {
      ...state.values,
      [currentPlaceholderId]: trimmedAnswer,
    };

    const updatedHistory = [
      ...state.history,
      { role: 'user', content: trimmedAnswer, placeholderId: currentPlaceholderId },
    ];

    let nextIndex = state.currentIndex + 1;
    while (nextIndex < state.order.length && updatedValues[state.order[nextIndex]]) {
      nextIndex += 1;
    }

    if (nextIndex >= state.order.length) {
      try {
        const { filledBuffer, filledHtml } = await generateFilledDocument(storedDocument, updatedValues);
        documentStore.set(docId, {
          ...storedDocument,
          filledBuffer,
          filledHtml,
          lastValues: updatedValues,
          questionState: {
            ...state,
            values: updatedValues,
            history: updatedHistory,
            currentIndex: nextIndex,
            completed: true,
          },
        });

        return res.json({
          done: true,
          previewHtml: filledHtml,
        });
      } catch (finalizeError) {
        console.error('Questionnaire finalize error', finalizeError);
        return res.status(500).json({ error: 'Failed to apply values to the document' });
      }
    }

    const nextPlaceholderId = state.order[nextIndex];
    const question = await generateQuestionForPlaceholder(storedDocument, nextPlaceholderId);

    documentStore.set(docId, {
      ...storedDocument,
      questionState: {
        ...state,
        currentIndex: nextIndex,
        values: updatedValues,
        history: [
          ...updatedHistory,
          { role: 'assistant', content: question, placeholderId: nextPlaceholderId },
        ],
      },
    });

    return res.json({
      done: false,
      message: question,
      placeholderId: nextPlaceholderId,
    });
  } catch (error) {
    console.error('Questionnaire answer error', error);
    return res.status(500).json({ error: 'Failed to process answer' });
  }
});

app.post('/api/finalize', async (req, res) => {
  try {
    const { docId, values } = req.body || {};

    if (!docId || !values || typeof values !== 'object') {
      return res.status(400).json({ error: 'docId and values are required' });
    }

    const storedDocument = documentStore.get(docId);
    if (!storedDocument) {
      return res.status(404).json({ error: 'Document not found' });
    }

    try {
      const { filledBuffer, filledHtml } = await generateFilledDocument(storedDocument, values);
      documentStore.set(docId, {
        ...storedDocument,
        filledBuffer,
        filledHtml,
        lastValues: values,
      });

      return res.json({
        docId,
        previewHtml: filledHtml,
      });
    } catch (finalizeError) {
      console.error('Finalize error', finalizeError);
      return res.status(500).json({ error: 'Failed to finalize document' });
    }
  } catch (error) {
    console.error('Finalize error', error);
    return res.status(500).json({ error: 'Failed to finalize document' });
  }
});

app.get('/api/documents/:docId/download', (req, res) => {
  const { docId } = req.params;
  const storedDocument = documentStore.get(docId);

  if (!storedDocument) {
    return res.status(404).json({ error: 'Document not found' });
  }

  const buffer = storedDocument.filledBuffer || storedDocument.originalBuffer;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${docId}-document.docx"`);
  return res.send(buffer);
});

app.get('/api/documents/:docId/download.pdf', async (req, res) => {
  const { docId } = req.params;
  const storedDocument = documentStore.get(docId);

  if (!storedDocument) {
    return res.status(404).json({ error: 'Document not found' });
  }

  const html = storedDocument.filledHtml || storedDocument.previewHtml || '';

  try {
    const pdfBuffer = await createPdfFromHtml(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${docId}-document.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('PDF download error', error);
    return res.status(500).json({ error: 'Unable to generate PDF' });
  }
});

async function generateQuestionForPlaceholder(storedDocument, placeholderId) {
  const placeholder = storedDocument.placeholders.find((item) => item.id === placeholderId);
  if (!placeholder) {
    return 'Please provide the required information.';
  }

  const placeholderMeta = storedDocument.placeholderMetadata?.[placeholderId];
  const contextSnippet = placeholder.context || placeholderMeta?.innerTrimmed || '';
  const documentOverview = truncateText(storedDocument.normalizedText || '', 800);
  const signatureMode = isSignaturePlaceholder(placeholder, placeholderMeta);

  const fallbackQuestion = signatureMode
    ? 'Please list each signing party with their full legal name, title, organisation, and any signing order notes so the signature panel can be completed.'
    : `Please provide a value for "${placeholder.label}".`;

  if (!openaiClient) {
    return fallbackQuestion;
  }

  const systemPrompt = [
    'You are a helpful assistant helping a legal professional complete a document.',
    'Ask the user exactly one concise, polite question to gather the information required for the placeholder.',
    'Do not propose a value yourself and do not ask multiple questions at once.',
    signatureMode
      ? 'This placeholder powers a signature section. Ensure the user provides the full legal names, titles, and organisations for every signing party, along with any extra details needed (e.g. signing order, date lines).'
      : undefined,
  ]
    .filter(Boolean)
    .join('\n');

  const userPromptParts = [
    `Placeholder label: ${placeholder.label}`,
    placeholderMeta?.type === 'dollar' && placeholderMeta?.innerTrimmed
      ? `Original placeholder text: ${placeholderMeta.innerTrimmed}`
      : undefined,
    contextSnippet ? `Surrounding text: ${contextSnippet}` : undefined,
    documentOverview ? `Document overview:\n${documentOverview}` : undefined,
    signatureMode
      ? 'Request the user to list every signing party with full name, title, organisation, and any signature block particulars (such as signing order or effective date).'
      : 'Ask the user one question to obtain the correct value for this placeholder.',
  ].filter(Boolean);

  try {
    const response = await openaiClient.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPromptParts.join('\n\n') },
      ],
      temperature: 0.1,
    });

    const completion = response?.choices?.[0]?.message?.content?.trim();
    if (!completion) {
      return fallbackQuestion;
    }

    return completion;
  } catch (error) {
    console.error('Question generation error', error);
    return fallbackQuestion;
  }
}

async function generateFilledDocument(storedDocument, values) {
  const zip = await JSZip.loadAsync(storedDocument.originalBuffer);
  const xmlFile = zip.file('word/document.xml');
  if (!xmlFile) {
    throw new Error('Invalid .docx structure (missing document.xml)');
  }

  let documentXml = await xmlFile.async('string');
  const metadata = storedDocument.placeholderMetadata || {};

  for (const [key, rawValue] of Object.entries(values)) {
    const value = typeof rawValue === 'string' ? rawValue : '';
    const placeholderMeta = metadata[key];

    if (placeholderMeta?.type === 'dollar') {
      documentXml = replaceDollarPlaceholder(documentXml, placeholderMeta, encodeXml(value));
      continue;
    }

    documentXml = replaceCurlyPlaceholder(documentXml, placeholderMeta, key, encodeXml(value));
  }

  zip.file('word/document.xml', documentXml);

  const filledBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  const filledHtmlResult = await mammoth.convertToHtml({ buffer: filledBuffer });
  const filledHtml = filledHtmlResult.value;

  return { filledBuffer, filledHtml };
}

async function discoverPlaceholders(documentXml) {
  const normalizedText = normalizeDocumentText(documentXml);

  if (!openaiClient) {
    const fallback = extractPlaceholdersFromXml(documentXml, normalizedText);
    return { ...fallback, normalizedText };
  }

  try {
    const candidates = await detectPlaceholdersWithOpenAI(normalizedText);
    const { placeholders, metadata } = buildPlaceholdersFromCandidates(candidates, normalizedText);

    if (placeholders.length > 0) {
      return { placeholders, metadata, normalizedText };
    }
  } catch (error) {
    console.error('OpenAI placeholder discovery error', error);
  }

  const fallback = extractPlaceholdersFromXml(documentXml, normalizedText);
  return { ...fallback, normalizedText };
}

function extractPlaceholdersFromXml(documentXml, normalizedText) {
  const searchText = normalizedText.replace(/\{\s+\{/g, '{{').replace(/\}\s+\}/g, '}}');
  const regex = /\{\{\s*([^{}]+?)\s*\}\}/g;
  const placeholders = [];
  const seen = new Set();
  const metadata = {};
  let match;

  while ((match = regex.exec(searchText)) !== null) {
    const rawKey = match[1].trim();
    if (!rawKey || seen.has(rawKey)) {
      continue;
    }

    const contextSnippet = extractContextSnippet(searchText, match.index, match[0].length);

    placeholders.push({
      id: rawKey,
      label: rawKey,
      context: contextSnippet,
    });
    metadata[rawKey] = {
      type: 'curly',
      raw: match[0],
      innerTrimmed: rawKey,
      xmlPattern: buildFlexibleXmlPattern(match[0]),
      source: 'fallback',
    };
    seen.add(rawKey);
  }

  const bracketRegex = /\$\[\s*([^\]]*?)\s*\]/g;
  const idUsage = new Set(Object.keys(metadata));
  const occurrenceTracker = new Map();
  let anonymousCounter = 0;

  while ((match = bracketRegex.exec(searchText)) !== null) {
    const rawInner = match[1] ?? '';
    const trimmedInner = rawInner.trim();
    const contextSnippet = extractContextSnippet(searchText, match.index, match[0].length);

    let baseId;
    let baseLabel;
    let isAnonymous = false;

    if (trimmedInner) {
      baseId = trimmedInner;
      baseLabel = trimmedInner;
    } else {
      anonymousCounter += 1;
      baseId = `placeholder_${anonymousCounter}`;
      baseLabel = `Placeholder ${anonymousCounter}`;
      isAnonymous = true;
    }

    let id = baseId;
    let suffix = 2;

    while (idUsage.has(id)) {
      id = `${baseId}_${suffix}`;
      suffix += 1;
    }
    idUsage.add(id);

    const label = suffix > 2 && !isAnonymous ? `${baseLabel} (${suffix - 1})` : baseLabel;

    const occurrenceKey = match[0];
    const occurrence = (occurrenceTracker.get(occurrenceKey) ?? 0) + 1;
    occurrenceTracker.set(occurrenceKey, occurrence);

    placeholders.push({
      id,
      label,
      context: contextSnippet,
    });

    metadata[id] = {
      type: 'dollar',
      raw: match[0],
      innerRaw: rawInner,
      innerTrimmed: trimmedInner,
      occurrence,
      xmlPattern: buildFlexibleXmlPattern(match[0]),
      source: 'fallback',
    };
  }

  return { placeholders, metadata };
}

async function detectPlaceholdersWithOpenAI(normalizedText) {
  const truncatedText = truncateText(normalizedText, Number(process.env.PLACEHOLDER_DISCOVERY_TEXT_LIMIT || 6000));

  const systemPrompt = [
    'You are an expert legal assistant. You analyse contract templates to identify dynamic sections that require user-provided values.',
    'Extract placeholder style tokens, obvious blanks, or labelled fields that need to be filled before the document is finalized.',
    'Respond with a JSON array. Each object must include: id (snake_case), label (human readable), raw (the exact placeholder text as it appears),',
    'type ("curly" for {{ }} style, "dollar" for $[ ] style, or "text" for other blanks), and context (short excerpt to help the user).',
    'If no placeholders are found, return an empty array []. Respond with JSON only.',
  ].join('\n');

  const userPrompt = [
    'Document content:',
    '"""',
    truncatedText,
    '"""',
    '',
    'Return JSON only. Example format:',
    '[{"id":"client_name","label":"Client name","raw":"{{ client_name }}","type":"curly","context":"Client: {{ client_name }}"}]',
  ].join('\n');

  const response = await openaiClient.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0,
  });

  const completion = response?.choices?.[0]?.message?.content ?? '';
  return parsePlaceholderArray(completion);
}

function buildPlaceholdersFromCandidates(candidates, normalizedText) {
  if (!Array.isArray(candidates)) {
    return { placeholders: [], metadata: {} };
  }

  const placeholders = [];
  const metadata = {};
  const usedIds = new Set();
  let anonymousCounter = 1;

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }

    const raw =
      stringField(candidate.raw) ||
      stringField(candidate.placeholder) ||
      stringField(candidate.token) ||
      '';

    if (!raw) {
      continue;
    }

    const initialId =
      sanitizeId(stringField(candidate.id)) ||
      sanitizeId(stringField(candidate.key)) ||
      sanitizeId(stringField(candidate.label)) ||
      sanitizeId(deriveInnerValueFromRaw(raw));

    let id = initialId;
    if (!id) {
      id = `placeholder_${anonymousCounter}`;
      anonymousCounter += 1;
    }

    const baseId = id;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${baseId}_${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);

    const label =
      stringField(candidate.label) ||
      deriveLabelFromId(id);

    const context =
      stringField(candidate.context) ||
      findContextFromRaw(normalizedText, raw);

    let type = stringField(candidate.type)?.toLowerCase();
    if (!type) {
      if (raw.includes('{{')) {
        type = 'curly';
      } else if (raw.includes('$[')) {
        type = 'dollar';
      } else {
        type = 'curly';
      }
    }

    const innerTrimmed =
      stringField(candidate.inner) ||
      stringField(candidate.valueName) ||
      deriveInnerValueFromRaw(raw, type);

    const occurrence = typeof candidate.occurrence === 'number' ? candidate.occurrence : undefined;

    placeholders.push({
      id,
      label,
      context: context || undefined,
    });

    metadata[id] = {
      type: type === 'dollar' ? 'dollar' : 'curly',
      raw,
      innerRaw: stringField(candidate.innerRaw) || raw,
      innerTrimmed,
      xmlPattern: buildFlexibleXmlPattern(raw),
      occurrence,
      source: 'openai',
    };
  }

  return { placeholders, metadata };
}

function truncateText(value, maxLength) {
  if (!value) {
    return '';
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function normalizeDocumentText(documentXml) {
  const withBreaks = documentXml
    .replace(/<w:tab[^>]*\/>/gi, '\t')
    .replace(/<w:br[^>]*\/>/gi, '\n')
    .replace(/<\/w:p>/gi, '\n');
  const withoutTags = withBreaks.replace(/<[^>]+>/g, '');
  return decodeXmlEntities(withoutTags);
}

function extractContextSnippet(text, index, length) {
  const window = 400;
  const start = Math.max(0, index - window);
  const end = Math.min(text.length, index + length + window);
  const snippet = text.slice(start, end);
  return snippet.replace(/\s+/g, ' ').trim();
}

function buildFlexibleXmlPattern(rawPlaceholder) {
  if (!rawPlaceholder) {
    return '';
  }

  const gap = '(?:\\s|<[^>]+>)*';
  const characters = Array.from(rawPlaceholder);
  const pattern = characters
    .map((character) => `${gap}${escapeRegExp(character)}`)
    .join('');
  return `${gap}${pattern}${gap}`;
}

function replaceDollarPlaceholder(documentXml, placeholderMeta, replacement) {
  const { occurrence, xmlPattern, raw } = placeholderMeta;
  const patternSource = xmlPattern && xmlPattern.length ? xmlPattern : buildFlexibleXmlPattern(raw ?? '$[]');
  const regex = new RegExp(patternSource, 'g');
  if (typeof occurrence === 'number') {
    return replaceNthOccurrence(documentXml, regex, occurrence, replacement);
  }

  return documentXml.replace(regex, () => replacement);
}

function replaceNthOccurrence(source, regex, occurrence, replacement) {
  let match;
  let count = 0;

  while ((match = regex.exec(source)) !== null) {
    count += 1;
    if (count === occurrence) {
      return `${source.slice(0, match.index)}${replacement}${source.slice(match.index + match[0].length)}`;
    }

    if (regex.lastIndex === match.index) {
      regex.lastIndex += 1;
    }
  }

  return source;
}

function replaceCurlyPlaceholder(documentXml, placeholderMeta, key, replacement) {
  if (placeholderMeta?.xmlPattern) {
    const regex = new RegExp(placeholderMeta.xmlPattern, 'g');
    return documentXml.replace(regex, () => replacement);
  }

  const fallbackPattern = new RegExp(`\\{\\{\\s*${escapeRegExp(key)}\\s*\\}\\}`, 'g');
  return documentXml.replace(fallbackPattern, () => replacement);
}

function stringField(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function deriveInnerValueFromRaw(raw, type) {
  if (!raw) {
    return '';
  }

  const normalizedType = type ? type.toLowerCase() : undefined;

  if (normalizedType === 'dollar') {
    return raw.replace(/^\$\[\s*/, '').replace(/\s*\]\s*$/, '').trim();
  }

  return raw.replace(/^\{\{\s*/, '').replace(/\s*\}\}\s*$/, '').trim();
}

function deriveLabelFromId(id) {
  if (!id) {
    return 'Placeholder';
  }

  return id
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function findContextFromRaw(normalizedText, raw) {
  if (!normalizedText || !raw) {
    return '';
  }

  const index = normalizedText.indexOf(raw);
  if (index === -1) {
    return '';
  }

  return extractContextSnippet(normalizedText, index, raw.length);
}

function parsePlaceholderArray(rawText) {
  if (!rawText) {
    return [];
  }

  const trimmed = rawText.trim();

  try {
    const direct = JSON.parse(trimmed);
    return Array.isArray(direct) ? direct : [];
  } catch {
    // fall through
  }

  const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

function sanitizeId(value) {
  if (!value) {
    return '';
  }

  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return sanitized;
}

function isSignaturePlaceholder(placeholder, placeholderMeta) {
  if (!placeholder) {
    return false;
  }

  const haystack = [placeholder.id, placeholder.label, placeholder.context, placeholderMeta?.innerTrimmed, placeholderMeta?.raw]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (!haystack) {
    return false;
  }

  const keywords = ['signature', 'signatory', 'signatures', 'signing party', 'signature panel', 'signature block'];
  return keywords.some((keyword) => haystack.includes(keyword));
}

function stripHtml(value) {
  return value.replace(/<[^>]+>/g, ' ');
}

function createPdfFromHtml(html) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50 });
      const chunks = [];

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const paragraphs = htmlToParagraphs(html);

      doc.fontSize(12);
      paragraphs.forEach((paragraph, index) => {
        if (paragraph.type === 'heading') {
          doc.moveDown(index === 0 ? 0 : 0.8);
          doc.fontSize(paragraph.level >= 3 ? 14 : 16).text(paragraph.text, { align: 'left' });
          doc.moveDown(0.3);
          doc.fontSize(12);
        } else if (paragraph.type === 'list-item') {
          doc.text(`• ${paragraph.text}`, { indent: 12, paragraphGap: 6 });
        } else {
          doc.text(paragraph.text, { paragraphGap: 10 });
        }
      });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

function htmlToParagraphs(html) {
  if (!html) {
    return [];
  }

  const fragments = [];
  let transformed = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<\/\s*li\s*>/gi, '\n')
    .replace(/<\/\s*(h[1-6]|p|div)\s*>/gi, '\n\n');

  const headingRegex = /<\s*h([1-6])[^>]*>([\s\S]*?)<\/\s*h\1\s*>/gi;
  transformed = transformed.replace(headingRegex, (_match, level, content) => {
    fragments.push({
      type: 'heading',
      level: Number(level),
      text: decodeXmlEntities(stripHtml(content)).trim(),
    });
    return '\n\n';
  });

  const cleaned = stripHtml(transformed);
  const decoded = decodeXmlEntities(cleaned);
  const paragraphs = decoded.split(/\n{2,}/).map((item) => item.replace(/\s+\n/g, '\n').trim());

  let fragmentIndex = 0;
  const result = [];

  paragraphs.forEach((paragraph) => {
    if (!paragraph) {
      return;
    }

    if (paragraph.startsWith('•')) {
      paragraph
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((item) => {
          result.push({ type: 'list-item', text: item.replace(/^•\s*/, '') });
        });
      return;
    }

    if (fragmentIndex < fragments.length) {
      const fragment = fragments[fragmentIndex];
      if (fragment && fragment.text.toLowerCase() === paragraph.toLowerCase()) {
        result.push(fragment);
        fragmentIndex += 1;
        return;
      }
    }

    result.push({ type: 'paragraph', text: paragraph });
  });

  return result;
}


function decodeXmlEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function encodeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseOrigins(value) {
  if (!value) {
    return undefined;
  }

  const origins = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    return undefined;
  }

  if (origins.length === 1) {
    return origins[0];
  }

  return origins;
}

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }

  if (err) {
    console.error('Unhandled error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }

  return res.status(500).json({ error: 'Unknown server error' });
});

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
