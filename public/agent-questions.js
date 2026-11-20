/**
 * Agent question forms (ESM module).
 *
 * Integration contract
 * --------------------
 *   import { createAgentQuestions } from './agent-questions.js';
 *   const renderAgentQuestions = createAgentQuestions(host, { answer, onSettled });
 *   renderAgentQuestions(requests);            // call after every poll / state refresh
 *
 * host       : DOM element that owns the rendered cards (cards are added/removed inside it).
 * answer     : `answer(id, answers) => Promise`, `id` is the request id, `answers` is
 *              `{ [questionId]: string }`. Resolves once the server accepted the answers.
 *              Rejects with an `Error` carrying an optional numeric `status` / `statusCode`
 *              (or `error.response.status`). 404 and 409 mean "request is gone or already
 *              answered" and are treated as settled (form cleared, onSettled called).
 *              Every other rejection is retryable: typed input is kept and the send button
 *              is re-enabled with an inline message.
 * onSettled  : `() => void`, called after a successful submit and after 404/409 so the panel
 *              can refresh task/thread state and call render() again with fresh data.
 *
 * requests   : already filtered for the active task/thread, in display order:
 *   { id, taskId, threadId, itemId, isBlocking,
 *     questions: [{ id, header, question, options: null | [{ label, description }],
 *                   isOther, isSecret }] }
 *   A request that disappears from the list is treated as expired and its card is removed.
 *   A request with no questions is ignored. A non-array argument is a no-op, so a transient
 *   `undefined` never wipes the UI.
 *
 * Behaviour: DOM is keyed by request id and reused across polls, so focus, typed answers and
 * open/closed state survive refreshes; nothing is persisted (no storage) and submitted values
 * are never read back from the server. Submit state is cleared on success, on 404/409 and on
 * expiration. `onSettled` is never awaited.
 */

const OTHER_LABEL = '其他';
const SEND_LABEL = '提交';
const SENDING_LABEL = '提交中…';
const SETTLED_STATUSES = [404, 409];
const SETTLED_CODES = ['not_found', 'conflict', 'expired', 'already_answered'];
const MAX_ERROR_TEXT = 200;

const TEXT = {
  sending: '正在提交…',
  pick: '请为每个问题选择一个选项',
  other: '请填写“其他”的内容',
  text: '请填写答案',
  invalid: '回答未通过校验，请检查后重试',
  forbidden: '没有权限提交，请刷新页面后重试',
  throttled: '提交过于频繁，请稍后重试',
  server: '服务暂时不可用，请重试',
  failed: '提交失败，请重试',
  unavailable: '答题功能未就绪，请刷新页面'
};

function isHost(node) {
  return !!node && typeof node === 'object' && typeof node.appendChild === 'function' && !!node.ownerDocument;
}

function toText(value) {
  return value === undefined || value === null ? '' : String(value);
}

function toOptions(question) {
  if (!question || !Array.isArray(question.options)) return [];
  const list = [];
  for (const raw of question.options) {
    if (raw && typeof raw === 'object') {
      list.push({ label: toText(raw.label), description: toText(raw.description) });
    } else {
      list.push({ label: toText(raw), description: '' });
    }
  }
  return list.filter((option) => option.label.length > 0);
}

function numericStatus(error) {
  if (!error) return null;
  const candidates = [error.status, error.statusCode, error.response && error.response.status, error.code];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d{3}$/.test(value.trim())) return Number(value.trim());
  }
  return null;
}

function isSettledError(error) {
  const status = numericStatus(error);
  if (status !== null && SETTLED_STATUSES.indexOf(status) !== -1) return true;
  const code = error && typeof error.code === 'string' ? error.code.toLowerCase() : '';
  return SETTLED_CODES.indexOf(code) !== -1;
}

function failureText(error) {
  const status = numericStatus(error);
  if (status === 400 || status === 422) return TEXT.invalid;
  if (status === 401 || status === 403) return TEXT.forbidden;
  if (status === 429) return TEXT.throttled;
  if (status !== null && status >= 500) return TEXT.server;
  const raw = typeof error === 'string' ? error : error && typeof error.message === 'string' ? error.message : '';
  const message = toText(raw).trim().slice(0, MAX_ERROR_TEXT);
  return message ? `${TEXT.failed}：${message}` : TEXT.failed;
}

function setFeedback(entry, message, state) {
  const node = entry.feedback;
  if (!node) return;
  node.textContent = message || '';
  if (state) {
    node.dataset.state = state;
  } else {
    delete node.dataset.state;
  }
}

export function createAgentQuestions(host, options) {
  if (!isHost(host)) {
    throw new TypeError('createAgentQuestions(host, options): host must be a DOM element');
  }
  const config = options || {};
  const answerFn = typeof config.answer === 'function' ? config.answer : null;
  const onSettledFn = typeof config.onSettled === 'function' ? config.onSettled : null;
  const doc = host.ownerDocument;
  const entries = new Map();
  let serial = 0;

  function notifySettled() {
    if (!onSettledFn) return;
    try {
      const pending = onSettledFn();
      if (pending && typeof pending.then === 'function') pending.then(undefined, () => {});
    } catch (error) {
      /* refresh failures are the panel's concern */
    }
  }

  function questionsOf(request) {
    return Array.isArray(request.questions)
      ? request.questions.filter((question) => question && typeof question === 'object')
      : [];
  }

  function structureKey(request) {
    const questions = questionsOf(request);
    return JSON.stringify([
      request.isBlocking === true,
      questions.map((question) => [
        toText(question.id),
        toText(question.header),
        toText(question.question),
        question.isOther === true,
        question.isSecret === true,
        toOptions(question).map((option) => [option.label, option.description])
      ])
    ]);
  }

  function currentDraft(entry) {
    const draft = {};
    for (const state of entry.states) draft[state.id] = state.raw();
    return draft;
  }

  function syncOther(state) {
    if (!state.otherInput) return;
    const active = !!(state.otherRadio && state.otherRadio.checked);
    state.otherInput.disabled = !active;
    state.otherInput.required = active;
  }

  function buildState(entry, question, index) {
    const qid = toText(question.id).trim() || `${entry.uid}-q${index + 1}`;
    const header = toText(question.header).trim();
    const prompt = toText(question.question).trim();
    const label = header || prompt || qid;
    const options = toOptions(question);
    const allowOther = options.length > 0 && question.isOther === true;
    const secret = question.isSecret === true;
    const fieldset = doc.createElement('fieldset');
    fieldset.className = 'agent-question-field';
    const legend = doc.createElement('legend');
    legend.className = 'agent-question-title';
    legend.textContent = label;
    fieldset.appendChild(legend);
    if (header && prompt && prompt !== header) {
      const body = doc.createElement('p');
      body.className = 'agent-question-text';
      body.textContent = prompt;
      fieldset.appendChild(body);
    }
    const name = `${entry.uid}-${index}`;
    const state = {
      id: qid,
      label,
      secret,
      kind: options.length > 0 ? 'options' : 'text',
      fieldset,
      radios: [],
      otherRadio: null,
      otherInput: null,
      textInput: null
    };
    if (options.length > 0) {
      for (const option of options) {
        const row = doc.createElement('label');
        row.className = 'agent-question-option';
        const radio = doc.createElement('input');
        radio.type = 'radio';
        radio.name = name;
        radio.value = option.label;
        radio.required = true;
        const caption = doc.createElement('span');
        caption.className = 'agent-question-option-label';
        caption.textContent = option.label;
        row.appendChild(radio);
        row.appendChild(caption);
        if (option.description) {
          const note = doc.createElement('span');
          note.className = 'agent-question-option-desc';
          note.textContent = option.description;
          row.appendChild(note);
        }
        fieldset.appendChild(row);
        state.radios.push(radio);
      }
      if (allowOther) {
        const row = doc.createElement('label');
        row.className = 'agent-question-option agent-question-other';
        const radio = doc.createElement('input');
        radio.type = 'radio';
        radio.name = name;
        radio.value = OTHER_LABEL;
        radio.required = true;
        const caption = doc.createElement('span');
        caption.className = 'agent-question-option-label';
        caption.textContent = OTHER_LABEL;
        row.appendChild(radio);
        row.appendChild(caption);
        fieldset.appendChild(row);
        const input = secret ? doc.createElement('input') : doc.createElement('textarea');
        input.className = 'agent-question-input';
        if (secret) {
          input.type = 'password';
          input.autocomplete = 'off';
        } else {
          input.rows = 2;
        }
        input.placeholder = '请填写内容';
        input.setAttribute('aria-label', `${OTHER_LABEL}：${label}`);
        input.disabled = true;
        fieldset.appendChild(input);
        radio.addEventListener('change', () => syncOther(state));
        state.otherRadio = radio;
        state.otherInput = input;
        state.radios.push(radio);
      }
    } else {
      const input = secret ? doc.createElement('input') : doc.createElement('textarea');
      input.className = 'agent-question-input';
      if (secret) {
        input.type = 'password';
        input.autocomplete = 'off';
      } else {
        input.rows = 3;
      }
      input.required = true;
      input.setAttribute('aria-label', label);
      fieldset.appendChild(input);
      state.textInput = input;
    }
    state.raw = () => {
      if (state.kind === 'options') {
        if (state.otherRadio && state.otherRadio.checked) return state.otherInput ? state.otherInput.value : '';
        const checked = state.radios.find((radio) => radio.checked && radio !== state.otherRadio);
        return checked ? checked.value : '';
      }
      return state.textInput ? state.textInput.value : '';
    };
    state.read = () => {
      const value = state.raw();
      const trimmed = state.secret ? value : value.trim();
      if (trimmed.length > 0) return { ok: true, value: trimmed };
      if (state.kind === 'options') {
        if (state.otherRadio && state.otherRadio.checked) {
          return { ok: false, reason: 'other', focus: state.otherInput };
        }
        return { ok: false, reason: 'pick', focus: state.radios[0] || null };
      }
      return { ok: false, reason: 'text', focus: state.textInput };
    };
    state.applyDraft = (value) => {
      if (typeof value !== 'string' || value.length === 0) return;
      if (state.kind === 'options') {
        const match = state.radios.find((radio) => radio !== state.otherRadio && radio.value === value);
        if (match) {
          match.checked = true;
          return;
        }
        if (state.otherRadio && state.otherInput) {
          state.otherRadio.checked = true;
          state.otherInput.value = value;
          syncOther(state);
        }
        return;
      }
      if (state.textInput) state.textInput.value = value;
    };
    return state;
  }

  function collect(entry) {
    const answers = {};
    for (const state of entry.states) {
      const result = state.read();
      if (!result.ok) {
        const message = result.reason === 'pick' ? TEXT.pick : result.reason === 'other' ? TEXT.other : TEXT.text;
        return { error: message, focus: result.focus || null };
      }
      answers[state.id] = result.value;
    }
    return { answers };
  }

  function buildEntry(request, draft) {
    const entry = {
      id: String(request.id),
      uid: `agent-question-${++serial}`,
      structureKey: structureKey(request),
      draft: Object.assign({}, draft || {}),
      states: [],
      submitting: false,
      root: null,
      form: null,
      sendBtn: null,
      feedback: null
    };
    const root = doc.createElement('section');
    root.className = 'agent-question approval-card';
    root.dataset.agentQuestionId = entry.id;
    if (request.isBlocking === true) root.dataset.blocking = 'true';
    const form = doc.createElement('form');
    form.className = 'agent-question-form';
    form.setAttribute('aria-label', '需要回答的问题');
    root.appendChild(form);
    for (const [index, question] of questionsOf(request).entries()) {
      const state = buildState(entry, question, index);
      entry.states.push(state);
      form.appendChild(state.fieldset);
      state.applyDraft(entry.draft[state.id]);
    }
    const feedback = doc.createElement('p');
    feedback.className = 'agent-question-feedback';
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');
    const actions = doc.createElement('div');
    actions.className = 'approval-btns';
    const sendBtn = doc.createElement('button');
    sendBtn.type = 'submit';
    sendBtn.className = 'agent-question-send';
    sendBtn.textContent = answerFn ? SEND_LABEL : TEXT.unavailable;
    if (!answerFn) sendBtn.disabled = true;
    actions.appendChild(sendBtn);
    root.appendChild(feedback);
    root.appendChild(actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submit(entry);
    });
    const trackDraft = () => {
      entry.draft = currentDraft(entry);
    };
    form.addEventListener('input', trackDraft);
    form.addEventListener('change', trackDraft);
    entry.root = root;
    entry.form = form;
    entry.sendBtn = sendBtn;
    entry.feedback = feedback;
    return entry;
  }

  function release(entry) {
    if (!entry) return;
    entry.submitting = false;
    if (entry.root && typeof entry.root.remove === 'function') {
      entry.root.remove();
    } else if (entry.root && entry.root.parentNode) {
      entry.root.parentNode.removeChild(entry.root);
    }
    if (entries.get(entry.id) === entry) entries.delete(entry.id);
  }

  function settle(entry) {
    release(entry);
    notifySettled();
  }

  function resetSend(entry) {
    entry.submitting = false;
    entry.sendBtn.disabled = false;
    entry.sendBtn.textContent = SEND_LABEL;
    entry.root.removeAttribute('aria-busy');
  }

  function submit(entry) {
    if (entry.submitting || !answerFn) return;
    const result = collect(entry);
    if (result.error) {
      setFeedback(entry, result.error, 'error');
      if (result.focus && typeof result.focus.focus === 'function') {
        try {
          result.focus.focus();
        } catch (error) {
          /* focus is best effort */
        }
      }
      if (entry.form && typeof entry.form.reportValidity === 'function') entry.form.reportValidity();
      return;
    }
    entry.submitting = true;
    entry.sendBtn.disabled = true;
    entry.sendBtn.textContent = SENDING_LABEL;
    entry.root.setAttribute('aria-busy', 'true');
    setFeedback(entry, TEXT.sending, 'pending');
    let pending;
    try {
      pending = answerFn(entry.id, result.answers);
    } catch (error) {
      pending = Promise.reject(error);
    }
    Promise.resolve(pending).then(
      () => settle(entry),
      (error) => {
        if (isSettledError(error)) {
          settle(entry);
          return;
        }
        if (entry.root && typeof entry.root.isConnected === 'boolean' && !entry.root.isConnected) return;
        resetSend(entry);
        setFeedback(entry, failureText(error), 'error');
      }
    );
  }

  function render(requests) {
    if (!Array.isArray(requests)) return;
    const order = [];
    const seen = new Set();
    for (const request of requests) {
      if (!request || request.id === undefined || request.id === null) continue;
      const key = String(request.id);
      if (seen.has(key)) continue;
      seen.add(key);
      order.push({ key, request });
    }
    for (const key of Array.from(entries.keys())) {
      if (!seen.has(key)) release(entries.get(key));
    }
    for (const item of order) {
      if (questionsOf(item.request).length === 0) continue;
      let entry = entries.get(item.key);
      if (entry) {
        const lost = entry.root.parentNode !== host
          || (typeof entry.root.isConnected === 'boolean' && !entry.root.isConnected);
        if (lost) entry = null;
      }
      if (!entry) {
        entry = buildEntry(item.request, null);
        entries.set(item.key, entry);
      } else if (entry.structureKey !== structureKey(item.request)) {
        const draft = currentDraft(entry);
        const rebuilt = buildEntry(item.request, draft);
        release(entry);
        entry = rebuilt;
        entries.set(item.key, entry);
      }
      host.appendChild(entry.root);
    }
  }

  return render;
}

export default createAgentQuestions;
