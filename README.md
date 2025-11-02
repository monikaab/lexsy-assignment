# Legal Document Assistant

An end-to-end sample project that pairs a SolidJS frontend with a Node.js backend to help legal teams turn contract templates into finalized agreements. Upload a `.docx` draft that uses `{{ placeholder }}` tokens, converse with an OpenAI-powered assistant to gather the missing details, and download the completed document.

## Folder structure

```
lexsy-assignment/
├─ backend/          # Express API for uploads, OpenAI conversations, and document generation
│  ├─ src/index.js   # Server entry point and route handlers
│  └─ .env.example   # Backend environment variable template
├─ frontend/         # SolidJS + Vite single-page app
│  ├─ src/           # App shell, UI components, and styles
│  ├─ index.html     # Root HTML template used by Vite
│  └─ .env.example   # Frontend environment variable template
└─ README.md
```

## Prerequisites

- Node.js 18+ (ensures access to modern `fetch`, `crypto.randomUUID`, and ES modules)
- npm or pnpm for dependency management
- An OpenAI API key with access to `gpt-4o-mini` or a compatible model

## Backend setup

1. Copy `backend/.env.example` to `backend/.env` and fill in the values:

   ```bash
   cp backend/.env.example backend/.env
   ```

   | Variable          | Description                                                                 |
   | ----------------- | --------------------------------------------------------------------------- |
   | `PORT`            | Port the server listens on (defaults to `3001`).                            |
   | `CLIENT_ORIGIN`   | Comma separated list of allowed origins (e.g., `http://localhost:5173`).    |
   | `OPENAI_API_KEY`  | Your OpenAI API key (required for the chat assistant).                      |
   | `OPENAI_MODEL`    | Optional model override (defaults to `gpt-4o-mini`).                        |

2. Install dependencies:

   ```bash
   cd backend
   npm install
   ```

3. Start the API server:

   ```bash
   npm run dev   # Uses nodemon for hot reloads
   # or
   npm start     # Runs the compiled server without reloading
   ```

   The server exposes:

   - `POST /api/upload` — accepts `.docx` uploads, extracts placeholders, and returns a preview.
   - `POST /api/conversation` — proxies chat messages to OpenAI to collect placeholder values.
   - `POST /api/finalize` — substitutes values into the original document and returns a new preview.
   - `GET /api/documents/:docId/download` — downloads the latest version of the document.
   - `GET /health` — basic readiness check.

   > ⚠️ The document store is in-memory. For production, back the `documents` map with a database or blob storage.

## Frontend setup

1. Copy the environment template if you want to override defaults:

   ```bash
   cp frontend/.env.example frontend/.env
   ```

   - `VITE_API_BASE_URL` — Set when the backend lives on a different origin (omit for dev proxy).
   - `VITE_API_PROXY` — Proxy target used by `npm run dev` (defaults to `http://localhost:3001`).

2. Install dependencies and run the dev server:

   ```bash
   cd frontend
   npm install
   npm run dev
   ```

   Vite hosts the SolidJS app at `http://localhost:5173` by default and proxies API calls to the backend.

3. Build for production (optional):

   ```bash
   npm run build
   npm run preview   # Serves the built assets locally
   ```

## Using the app

1. Visit the frontend (`http://localhost:5173`) and upload a `.docx` template that uses `{{ placeholder }}` tokens for dynamic sections.
2. Review the auto-detected placeholders and switch between them using the pill selector.
3. Ask the OpenAI assistant for help with each placeholder. When satisfied, copy the response or type your own value.
4. Once every placeholder has a value, click **Finalize & preview** to generate the completed document.
5. Download the final `.docx` via the **Download .docx** button. The preview pane updates to reflect your substitutions.

### Placeholder detection tips

- Placeholders must appear in the document as `{{ placeholder_name }}` without spanning multiple paragraphs or styled runs.
- The backend performs direct string replacement in `word/document.xml`. For complex templates or conditional content, adapt the logic to use a templating engine such as Docxtemplater.

### Conversation flow

Each chat request flows through the backend so the server can:

1. Attach context around the placeholder pulled from `document.xml`.
2. Enforce a system prompt that nudges concise, clause-ready answers.
3. Isolate your OpenAI API key from the browser.

Feel free to extend the chat history persistence or integrate authentication as required for your deployment.

## Deployment notes

- Serve the built frontend assets with your preferred static host (e.g., Vercel, Netlify, S3/CloudFront).
- Deploy the backend as a Node service on platforms such as Fly.io, Render, or Azure. Remember to provision persistent storage for uploaded documents.
- Harden the API before going public: add auth, rate limiting, file-type validation, and antivirus scanning as needed for legal workflows.

## Next steps

- Replace the in-memory store with a database or object storage bucket.
- Add support for additional template syntaxes or upload types (PDF, HTML).
- Persist chat transcripts so users can revisit their decisions.
- Integrate organization-specific prompt libraries for tailored drafting guidance.

Happy building!
