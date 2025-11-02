import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import DOMPurify from 'dompurify';

interface Placeholder {
  id: string;
  label: string;
  context?: string;
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

interface QuestionnaireResponse {
  done: boolean;
  message?: string;
  placeholderId?: string;
  previewHtml?: string;
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
  const [chatMessages, setChatMessages] = createSignal<ChatMessage[]>([]);
  const [currentPlaceholderId, setCurrentPlaceholderId] = createSignal<string | null>(null);
  const [answeredPlaceholderIds, setAnsweredPlaceholderIds] = createSignal<string[]>([]);
  const [uploading, setUploading] = createSignal(false);
  const [chatInput, setChatInput] = createSignal('');
  const [chatLoading, setChatLoading] = createSignal(false);
  const [questionnaireActive, setQuestionnaireActive] = createSignal(false);
  const [questionnaireComplete, setQuestionnaireComplete] = createSignal(false);
  const [statusMessage, setStatusMessage] = createSignal<string | null>(null);
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
  const [selectedFileName, setSelectedFileName] = createSignal<string | null>(null);
  let chatThreadRef: HTMLDivElement | undefined;

  const placeholderCount = createMemo(() => documentMeta()?.placeholders.length ?? 0);
  const answeredCount = createMemo(() => answeredPlaceholderIds().length);
  const remainingQuestions = createMemo(() => Math.max(placeholderCount() - answeredCount(), 0));

  const canShowPreview = createMemo(() => {
    const doc = documentMeta();
    if (!doc) return false;
    if (doc.filledPreviewHtml) return true;
    return questionnaireComplete();
  });

  const sanitizedPreview = createMemo(() => {
    const doc = documentMeta();
    if (!doc) return '';
    const html = doc.filledPreviewHtml ?? (questionnaireComplete() ? doc.previewHtml : '');
    return html ? DOMPurify.sanitize(html) : '';
  });

  function resetState() {
    setDocumentMeta(null);
    setChatMessages([]);
    setCurrentPlaceholderId(null);
    setAnsweredPlaceholderIds([]);
    setChatInput('');
    setChatLoading(false);
    setQuestionnaireActive(false);
    setQuestionnaireComplete(false);
    setStatusMessage(null);
    setErrorMessage(null);
    setSelectedFileName(null);
  }

  createEffect(() => {
    chatMessages();
    queueMicrotask(() => {
      if (chatThreadRef) {
        chatThreadRef.scrollTop = chatThreadRef.scrollHeight;
      }
    });
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
    setChatMessages([]);
    setCurrentPlaceholderId(null);
    setAnsweredPlaceholderIds([]);
    setChatInput('');
    setQuestionnaireActive(false);
    setQuestionnaireComplete(false);
    setDocumentMeta(null);

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
      setStatusMessage('Preparing the assistant for your template...');
      await startQuestionnaire(payload.docId);
    } catch (error) {
      console.error(error);
      setErrorMessage(error instanceof Error ? error.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function startQuestionnaire(docId: string) {
    if (!docId) return;

    setChatMessages([]);
    setCurrentPlaceholderId(null);
    setAnsweredPlaceholderIds([]);
    setQuestionnaireComplete(false);
    setQuestionnaireActive(false);
    setChatInput('');
    setChatLoading(true);
    setErrorMessage(null);

    try {
      const response = await fetch(buildUrl('/api/questionnaire/start'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ docId }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? 'Unable to start assistant questionnaire');
      }

      const payload = (await response.json()) as QuestionnaireResponse;

      if (payload.done) {
        setQuestionnaireComplete(true);
        setQuestionnaireActive(false);
        setCurrentPlaceholderId(null);
        if (payload.previewHtml) {
          setDocumentMeta((prev) => (prev ? { ...prev, filledPreviewHtml: payload.previewHtml } : prev));
        }
        setStatusMessage('Document is ready to preview and download.');
        return;
      }

      const placeholderId = payload.placeholderId ?? null;
      setCurrentPlaceholderId(placeholderId);
      setQuestionnaireActive(true);

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: payload.message ?? 'Please provide the required information.',
        id: newId(),
      };

      setChatMessages([assistantMessage]);
      setStatusMessage('Answer the assistant to complete the document.');
    } catch (error) {
      console.error(error);
      setErrorMessage(error instanceof Error ? error.message : 'Failed to start assistant questionnaire');
      setStatusMessage(null);
      setQuestionnaireActive(false);
      setQuestionnaireComplete(false);
      setChatMessages([]);
      setCurrentPlaceholderId(null);
    } finally {
      setChatLoading(false);
    }
  }

  async function submitAnswer(event: Event) {
    event.preventDefault();
    const doc = documentMeta();
    const placeholderId = currentPlaceholderId();
    const message = chatInput().trim();

    if (!doc || !placeholderId || !message) {
      return;
    }

    const userMessage: ChatMessage = { role: 'user', content: message, id: newId() };
    setChatMessages((prev) => [...prev, userMessage]);
    setChatInput('');
    setChatLoading(true);
    setErrorMessage(null);

    try {
      const response = await fetch(buildUrl('/api/questionnaire/answer'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          docId: doc.docId,
          answer: message,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? 'Assistant failed to process your answer');
      }

      const payload = (await response.json()) as QuestionnaireResponse;

      setAnsweredPlaceholderIds((prev) => (prev.includes(placeholderId) ? prev : [...prev, placeholderId]));

      if (payload.done) {
        setQuestionnaireComplete(true);
        setQuestionnaireActive(false);
        setCurrentPlaceholderId(null);
        if (payload.previewHtml) {
          setDocumentMeta((prev) => (prev ? { ...prev, filledPreviewHtml: payload.previewHtml } : prev));
        }
        setStatusMessage('All placeholders captured. Review the preview and download the .docx file.');
        return;
      }

      const nextPlaceholderId = payload.placeholderId ?? null;
      setCurrentPlaceholderId(nextPlaceholderId);

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: payload.message ?? 'Please provide the next value.',
        id: newId(),
      };

      setChatMessages((prev) => [...prev, assistantMessage]);
      setStatusMessage('Keep answering until the assistant completes the document.');
    } catch (error) {
      console.error(error);
      setChatMessages((prev) => prev.filter((item) => item.id !== userMessage.id));
      setChatInput(message);
      setErrorMessage(error instanceof Error ? error.message : 'Failed to send answer');
    } finally {
      setChatLoading(false);
    }
  }

  async function downloadDocument() {
    const doc = documentMeta();
    if (!doc || (!questionnaireComplete() && !doc.filledPreviewHtml)) return;

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

  return (
    <div class="container">
      <header class="app-header">
        <h1>Legal Document Assistant</h1>
        <p>
          Upload a contract template with placeholders such as <strong>{'{{ client_name }}'}</strong> or <strong>{'$[_____________]'}</strong>.
          The assistant will gather the missing information and produce a completed document ready for download.
        </p>
      </header>

      <section class="card">
        <div class="section-title">
          <h2>1. Upload template</h2>
          <button class="ghost" type="button" onClick={resetState} disabled={!documentMeta() && !selectedFileName()}>
            Reset
          </button>
        </div>
        <label class="upload-dropzone">
          <strong>Drop a .docx template</strong>
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
              <h2>2. Answer the assistant</h2>
              <div class="badge">
                {questionnaireComplete()
                  ? 'All questions answered'
                  : `Questions remaining: ${remainingQuestions()}`}
              </div>
            </div>

            <div class="chat-thread" ref={chatThreadRef}>
              <Show when={!chatMessages().length && chatLoading()}>
                <div class="status">Preparing your first question…</div>
              </Show>
              <For each={chatMessages()}>
                {(message) => (
                  <div class={`chat-bubble ${message.role}`}>
                    {message.content}
                  </div>
                )}
              </For>
            </div>

            <form onSubmit={submitAnswer}>
              <textarea
                placeholder={
                  questionnaireComplete()
                    ? 'All questions answered'
                    : questionnaireActive()
                    ? 'Type your answer and press send'
                    : 'Waiting for the assistant...'
                }
                value={chatInput()}
                onInput={(event) => setChatInput(event.currentTarget.value)}
                disabled={chatLoading() || questionnaireComplete() || !questionnaireActive()}
                required
              />
              <div class="chat-actions">
                <button
                  class="primary"
                  type="submit"
                  disabled={chatLoading() || questionnaireComplete() || !questionnaireActive()}
                >
                  {chatLoading() ? 'Processing…' : 'Send answer'}
                </button>
              </div>
            </form>
          </section>

          <section class="card">
            <div class="section-title">
              <h2>3. Preview & download</h2>
              <div class="badge">Placeholders detected: {placeholderCount()}</div>
            </div>

            <Show when={canShowPreview()} fallback={<div class="status">Preview unlocks after the assistant finishes gathering answers.</div>}>
              <div class="document-preview" innerHTML={sanitizedPreview()} />
            </Show>

            <div class="chat-actions" style={{ 'margin-top': '1.5rem' }}>
              <button
                class="ghost"
                type="button"
                onClick={downloadDocument}
                disabled={!canShowPreview()}
              >
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
