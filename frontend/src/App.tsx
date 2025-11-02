import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import { createStore } from 'solid-js/store';
import DOMPurify from 'dompurify';

interface Placeholder {
  id: string;
  label: string;
  context?: string;
}

interface PlaceholderSession {
  messages: ChatMessage[];
  value: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  id: string;
}

interface UploadResponse {
  docId: string;
  placeholders: Placeholder[];
  previewHtml: string;
}

interface ConversationResponse {
  message: { role: 'assistant'; content: string };
}

interface FinalizeResponse {
  docId: string;
  previewHtml: string;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

function buildUrl(path: string) {
  if (!API_BASE) {
    return path;
  }

  return `${API_BASE.replace(/\/$/, '')}${path}`;
}

function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

export default function App() {
  const [documentMeta, setDocumentMeta] = createSignal<UploadResponse & { filledPreviewHtml?: string } | null>(null);
  const [selectedPlaceholderId, setSelectedPlaceholderId] = createSignal<string | null>(null);
  const [sessions, setSessions] = createStore<Record<string, PlaceholderSession>>({});
  const [uploading, setUploading] = createSignal(false);
  const [chatInput, setChatInput] = createSignal('');
  const [chatLoading, setChatLoading] = createSignal(false);
  const [finalizing, setFinalizing] = createSignal(false);
  const [statusMessage, setStatusMessage] = createSignal<string | null>(null);
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
  const [selectedFileName, setSelectedFileName] = createSignal<string | null>(null);

  const activePlaceholder = createMemo(() => {
    const doc = documentMeta();
    if (!doc) return undefined;
    const current = selectedPlaceholderId();
    return doc.placeholders.find((item) => item.id === current);
  });

  const activeSession = createMemo(() => {
    const current = selectedPlaceholderId();
    if (!current) return undefined;
    return sessions[current];
  });

  const sanitizedPreview = createMemo(() => {
    const doc = documentMeta();
    if (!doc) return '';
    const html = doc.filledPreviewHtml ?? doc.previewHtml;
    return DOMPurify.sanitize(html);
  });

  createEffect(() => {
    const doc = documentMeta();
    if (!doc) return;
    if (!selectedPlaceholderId() && doc.placeholders.length > 0) {
      const firstId = doc.placeholders[0]?.id ?? null;
      if (firstId) {
        setSelectedPlaceholderId(firstId);
      }
    }
  });

  createEffect(() => {
    const placeholderId = selectedPlaceholderId();
    if (placeholderId) {
      setChatInput('');
    }
  });

  function handleFileChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      setSelectedFileName(file.name);
      void uploadDocument(file);
    }
  }

  async function uploadDocument(file: File) {
    setUploading(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch(buildUrl('/api/upload'), {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? 'Unable to upload document');
      }

      const payload = (await response.json()) as UploadResponse;
      setDocumentMeta({ ...payload });
      setSessions(() => ({}));
      payload.placeholders.forEach((placeholder) => {
        setSessions(placeholder.id, { messages: [], value: '' });
      });
      setSelectedPlaceholderId(payload.placeholders[0]?.id ?? null);
      setStatusMessage(`Found ${payload.placeholders.length} placeholders to review.`);
    } catch (error) {
      console.error(error);
      setErrorMessage(error instanceof Error ? error.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function sendMessage(event: Event) {
    event.preventDefault();
    const doc = documentMeta();
    const placeholder = activePlaceholder();
    const message = chatInput().trim();

    if (!doc || !placeholder || !message) return;

    const placeholderId = placeholder.id;
    const existingMessages = sessions[placeholderId]?.messages ?? [];
    const userMessage = { role: 'user' as const, content: message, id: newId() };
    const conversationPayload = [
      ...existingMessages.map(({ role, content }) => ({ role, content })),
      { role: 'user', content: message },
    ];

    setSessions(placeholderId, (current) => current ?? { messages: [], value: '' });
    setSessions(placeholderId, 'messages', (prev) => [...(prev ?? []), userMessage]);
    setChatInput('');
    setChatLoading(true);

    try {
      const response = await fetch(buildUrl('/api/conversation'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          docId: doc.docId,
          placeholderId,
          messages: conversationPayload,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? 'Assistant failed to respond');
      }

      const payload = (await response.json()) as ConversationResponse;
      const reply = payload.message;
      setSessions(placeholderId, 'messages', (prev) => [
        ...prev,
        { role: 'assistant', content: reply.content, id: newId() },
      ]);
    } catch (error) {
      console.error(error);
      setErrorMessage(error instanceof Error ? error.message : 'Assistant error');
    } finally {
      setChatLoading(false);
    }
  }

  function useAssistantReply() {
    const placeholderId = selectedPlaceholderId();
    if (!placeholderId) return;
    const session = sessions[placeholderId];
    const lastAssistant = [...(session?.messages ?? [])].reverse().find((message) => message.role === 'assistant');
    if (lastAssistant) {
      setSessions(placeholderId, 'value', lastAssistant.content);
    }
  }

  async function finalizeDocument() {
    const doc = documentMeta();
    if (!doc) return;

    const missing = doc.placeholders.filter((placeholder) => !sessions[placeholder.id]?.value?.trim());
    if (missing.length > 0) {
      setErrorMessage(`Please provide values for: ${missing.map((item) => item.label).join(', ')}`);
      return;
    }

    setFinalizing(true);
    setErrorMessage(null);
    setStatusMessage('Finalizing your document...');

    try {
      const values = Object.fromEntries(
        doc.placeholders.map((placeholder) => [placeholder.id, sessions[placeholder.id]?.value ?? ''])
      );

      const response = await fetch(buildUrl('/api/finalize'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          docId: doc.docId,
          values,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? 'Failed to finalize document');
      }

      const payload = (await response.json()) as FinalizeResponse;
      setDocumentMeta((prev) => (prev ? { ...prev, filledPreviewHtml: payload.previewHtml } : prev));
      setStatusMessage('Document finalized. You can review the preview or download the .docx file.');
    } catch (error) {
      console.error(error);
      setErrorMessage(error instanceof Error ? error.message : 'Failed to finalize document');
    } finally {
      setFinalizing(false);
    }
  }

  function handleValueChange(event: Event) {
    const placeholderId = selectedPlaceholderId();
    if (!placeholderId) return;
    const target = event.currentTarget as HTMLTextAreaElement;
    setSessions(placeholderId, 'value', target.value);
  }

  function resetState() {
    setDocumentMeta(null);
    setSessions(() => ({}));
    setSelectedPlaceholderId(null);
    setChatInput('');
    setStatusMessage(null);
    setErrorMessage(null);
    setSelectedFileName(null);
  }

  async function downloadDocument() {
    const doc = documentMeta();
    if (!doc) return;

    const url = buildUrl(`/api/documents/${encodeURIComponent(doc.docId)}/download`);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Unable to download document');
      }

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = `${doc.docId}-document.docx`;
      anchor.click();
      URL.revokeObjectURL(blobUrl);
    } catch (error) {
      console.error(error);
      setErrorMessage(error instanceof Error ? error.message : 'Download failed');
    }
  }

  const placeholderCount = createMemo(() => documentMeta()?.placeholders.length ?? 0);

  return (
    <div class="container">
      <header class="app-header">
        <h1>Legal Document Assistant</h1>
        <p>
          Upload a contract template with <strong>{'{{ placeholder }}'}</strong> style tokens to flag dynamic sections. Collaborate with the AI
          assistant to draft the missing details, preview the completed document, and download the final .docx file.
        </p>
      </header>

      <section class="card">
        <div class="section-title">
          <h2>1. Upload template</h2>
          <button class="ghost" type="button" onClick={resetState} disabled={!documentMeta()}>
            Reset
          </button>
        </div>
        <label class="upload-dropzone">
          <strong>Drop a .docx template</strong>
          {/* <div class="helper-text">or click to browse your files</div> */}
          <input
            type="file"
            accept=".docx"
            style={{ display: 'none' }}
            disabled={uploading()}
            onChange={handleFileChange}
          />
        </label>
        <Show when={selectedFileName()}>
          {(name) => <div class="file-info">Selected file: {name}</div>}
        </Show>
        <Show when={uploading()}>
          <div class="status">Uploading...</div>
        </Show>
      </section>

      <Show when={documentMeta()}>
        <div class="layout">
          <section class="card">
            <div class="section-title">
              <h2>2. Preview</h2>
              <div class="badge">Placeholders detected: {placeholderCount()}</div>
            </div>
            <div class="document-preview" innerHTML={sanitizedPreview()} />
          </section>

          <section class="card">
            <div class="section-title">
              <h2>3. Fill placeholders</h2>
            </div>

            <div class="placeholder-list">
              <For each={documentMeta()?.placeholders ?? []}>
                {(placeholder) => (
                  <button
                    type="button"
                    class={`placeholder-pill ${selectedPlaceholderId() === placeholder.id ? 'active' : ''}`}
                    onClick={() => setSelectedPlaceholderId(placeholder.id)}
                  >
                    {placeholder.label}
                  </button>
                )}
              </For>
            </div>

            <Show when={activePlaceholder()}>
              {(placeholder) => (
                <div class="values-panel">
                  <Show when={placeholder().context}>
                    {(context) => <div class="badge">Context: {context}</div>}
                  </Show>

                  <div class="chat-thread">
                    <For each={activeSession()?.messages ?? []}>
                      {(message) => (
                        <div class={`chat-bubble ${message.role}`}>
                          {message.content}
                        </div>
                      )}
                    </For>
                  </div>

                  <form onSubmit={sendMessage}>
                    <textarea
                      placeholder={`Ask for help filling ${placeholder().label}`}
                      value={chatInput()}
                      onInput={(event) => setChatInput(event.currentTarget.value)}
                      disabled={chatLoading()}
                      required
                    />
                    <div class="chat-actions">
                      <button class="primary" type="submit" disabled={chatLoading()}>
                        {chatLoading() ? 'Thinking…' : 'Ask assistant'}
                      </button>
                      <button
                        type="button"
                        class="ghost"
                        onClick={useAssistantReply}
                        disabled={!activeSession()?.messages?.length}
                      >
                        Use last reply
                      </button>
                    </div>
                  </form>

                  <label>
                    Provide final value
                    <textarea value={activeSession()?.value ?? ''} onInput={handleValueChange} />
                  </label>
                </div>
              )}
            </Show>

            <div class="chat-actions" style={{ 'margin-top': '1.5rem' }}>
              <button class="primary" type="button" onClick={finalizeDocument} disabled={finalizing()}>
                {finalizing() ? 'Finalizing…' : 'Finalize & preview'}
              </button>
              <button class="ghost" type="button" onClick={downloadDocument}>
                Download .docx
              </button>
            </div>
          </section>
        </div>
      </Show>

      <Show when={statusMessage()}>
        {(message) => <div class="status success">{message}</div>}
      </Show>

      <Show when={errorMessage()}>
        {(message) => <div class="status error">{message}</div>}
      </Show>
    </div>
  );
}
