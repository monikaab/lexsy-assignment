import express from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { v4 as uuid } from 'uuid';
import OpenAI from 'openai';

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
    const placeholders = extractPlaceholders(documentXml);

    documentStore.set(docId, {
      originalBuffer: buffer,
      previewHtml,
      placeholders,
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

app.post('/api/conversation', async (req, res) => {
  try {
    if (!openaiClient) {
      return res.status(500).json({ error: 'OpenAI API key is not configured on the server' });
    }

    const { docId, placeholderId, messages } = req.body || {};

    if (!docId || !placeholderId || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'docId, placeholderId, and messages are required' });
    }

    const storedDocument = documentStore.get(docId);
    if (!storedDocument) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const placeholder = storedDocument.placeholders.find((item) => item.id === placeholderId);
    if (!placeholder) {
      return res.status(404).json({ error: 'Placeholder not found' });
    }

    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    const chatMessages = [
      {
        role: 'system',
        content: [
          'You are a helpful assistant for legal document drafting.',
          'Gather precise information from the user to fill in the placeholder provided.',
          'Produce concise answers suitable for direct insertion into the document.',
          `Placeholder: ${placeholder.id}`,
          placeholder.context ? `Context: ${placeholder.context}` : undefined,
        ]
          .filter(Boolean)
          .join('\n'),
      },
      ...messages
        .filter((message) => typeof message?.role === 'string' && typeof message?.content === 'string')
        .map((message) => ({ role: message.role, content: message.content })),
    ];

    const response = await openaiClient.chat.completions.create({
      model,
      messages: chatMessages,
      temperature: 0.2,
    });

    const completion = response?.choices?.[0]?.message;
    if (!completion) {
      return res.status(502).json({ error: 'No completion returned from OpenAI' });
    }

    return res.json({ message: completion });
  } catch (error) {
    console.error('Conversation error', error);
    return res.status(500).json({ error: 'Failed to generate assistant response' });
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

    const zip = await JSZip.loadAsync(storedDocument.originalBuffer);
    const xmlFile = zip.file('word/document.xml');
    if (!xmlFile) {
      return res.status(400).json({ error: 'Invalid .docx structure (missing document.xml)' });
    }

    let documentXml = await xmlFile.async('string');

    for (const [key, rawValue] of Object.entries(values)) {
      const value = typeof rawValue === 'string' ? rawValue : '';
      const placeholderPattern = new RegExp(`\\{\\{\\s*${escapeRegExp(key)}\\s*\\}\\}`, 'g');
      documentXml = documentXml.replace(placeholderPattern, encodeXml(value));
    }

    zip.file('word/document.xml', documentXml);

    const filledBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    const filledHtmlResult = await mammoth.convertToHtml({ buffer: filledBuffer });
    const filledHtml = filledHtmlResult.value;

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

function extractPlaceholders(documentXml) {
  const regex = /\{\{\s*([^{}]+?)\s*\}\}/g;
  const placeholders = [];
  const seen = new Set();
  let match;

  while ((match = regex.exec(documentXml)) !== null) {
    const rawKey = match[1].trim();
    if (!rawKey || seen.has(rawKey)) {
      continue;
    }

    const contextSnippet = extractContextSnippet(documentXml, match.index, match[0].length);

    placeholders.push({
      id: rawKey,
      label: rawKey,
      context: contextSnippet,
    });
    seen.add(rawKey);
  }

  return placeholders;
}

function extractContextSnippet(xml, index, length) {
  const window = 400;
  const start = Math.max(0, index - window);
  const end = Math.min(xml.length, index + length + window);
  const snippet = xml.slice(start, end);
  return decodeXmlEntities(stripXml(snippet));
}

function stripXml(value) {
  return value.replace(/<[^>]+>/g, ' ');
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
