class RoomAppPoll extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._bridge = null;
    this._polls = [];
    this._results = {};
    this._unsubscribe = null;
    this._optionCount = 2;
  }

  setBridge(bridge) {
    this._bridge = bridge;
    this._init();
  }

  async _init() {
    this._render();
    await this._loadPolls();

    this._unsubscribe = this._bridge.subscribe('updated', async (data) => {
      if (data && data.pollId && this._results[data.pollId] !== undefined) {
        try {
          const results = await this._bridge.request('results', { pollId: data.pollId });
          this._results[data.pollId] = results;
          this._renderPolls();
        } catch (e) {
          console.error('[PollApp] Failed to refresh results:', e);
        }
      } else {
        await this._loadPolls();
      }
    });
  }

  async _loadPolls() {
    try {
      const polls = await this._bridge.request('list');
      this._polls = polls || [];
      for (const p of this._polls) {
        const results = await this._bridge.request('results', { pollId: p.id });
        this._results[p.id] = results;
      }
      this._renderPolls();
    } catch (e) {
      console.error('[PollApp] Failed to load polls:', e);
    }
  }

  _render() {
    const style = document.createElement('style');
    style.textContent = `
      :host { display: flex; flex-direction: column; height: 100%; color: #e2e8f0; font-family: system-ui, sans-serif; }
      .container { flex: 1; overflow-y: auto; padding: 16px; }
      .create-form { padding: 16px; border-top: 1px solid #1e293b; background: #0f172a; }
      .form-row { display: flex; gap: 8px; margin-bottom: 8px; }
      input, button { font-family: inherit; font-size: 13px; }
      input { background: #1e293b; border: 1px solid #334155; color: #e2e8f0; padding: 6px 10px; border-radius: 4px; flex: 1; }
      input:focus { outline: none; border-color: #3b82f6; }
      button { cursor: pointer; border: none; border-radius: 4px; padding: 6px 12px; }
      .btn-primary { background: #3b82f6; color: white; }
      .btn-primary:hover { background: #2563eb; }
      .btn-danger { background: #ef4444; color: white; font-size: 11px; padding: 4px 8px; }
      .btn-secondary { background: #334155; color: #cbd5e1; font-size: 12px; }
      .poll-card { background: #1e293b; border-radius: 8px; padding: 14px; margin-bottom: 12px; }
      .poll-question { font-size: 15px; font-weight: 600; margin-bottom: 10px; }
      .poll-meta { font-size: 11px; color: #64748b; margin-bottom: 8px; }
      .option { margin-bottom: 6px; cursor: pointer; }
      .option.voted { cursor: default; }
      .option-bar { display: flex; align-items: center; gap: 8px; }
      .bar-bg { flex: 1; height: 24px; background: #0f172a; border-radius: 4px; overflow: hidden; position: relative; }
      .bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s; display: flex; align-items: center; padding-left: 8px; font-size: 12px; min-width: fit-content; }
      .bar-fill.selected { background: #3b82f6; }
      .bar-fill.other { background: #334155; }
      .vote-count { font-size: 12px; color: #94a3b8; min-width: 30px; text-align: right; }
      .closed-badge { display: inline-block; background: #7f1d1d; color: #fca5a5; font-size: 11px; padding: 2px 6px; border-radius: 4px; margin-left: 8px; }
      .empty { text-align: center; color: #64748b; padding: 40px; }
      .add-option { font-size: 12px; color: #3b82f6; cursor: pointer; background: none; border: none; padding: 4px 0; }
    `;
    this.shadowRoot.appendChild(style);

    const container = document.createElement('div');
    container.className = 'container';
    container.setAttribute('id', 'polls-container');
    this.shadowRoot.appendChild(container);

    const form = document.createElement('div');
    form.className = 'create-form';
    form.setAttribute('id', 'create-form');
    this.shadowRoot.appendChild(form);
    this._renderCreateForm();
  }

  _renderCreateForm() {
    const form = this.shadowRoot.getElementById('create-form');
    while (form.firstChild) form.removeChild(form.firstChild);

    const title = document.createElement('div');
    title.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:8px;';
    title.textContent = 'Create a Poll';
    form.appendChild(title);

    const qRow = document.createElement('div');
    qRow.className = 'form-row';
    const qInput = document.createElement('input');
    qInput.placeholder = 'Ask a question...';
    qInput.setAttribute('id', 'poll-question');
    qRow.appendChild(qInput);
    form.appendChild(qRow);

    const optionsDiv = document.createElement('div');
    optionsDiv.setAttribute('id', 'options-list');
    form.appendChild(optionsDiv);

    this._renderOptionInputs();

    const actions = document.createElement('div');
    actions.className = 'form-row';
    actions.style.marginTop = '4px';

    const addBtn = document.createElement('button');
    addBtn.className = 'add-option';
    addBtn.textContent = '+ Add option';
    addBtn.onclick = () => { this._optionCount++; this._renderOptionInputs(); };
    actions.appendChild(addBtn);

    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    actions.appendChild(spacer);

    const submitBtn = document.createElement('button');
    submitBtn.className = 'btn-primary';
    submitBtn.textContent = 'Create Poll';
    submitBtn.onclick = () => this._handleCreate();
    actions.appendChild(submitBtn);
    form.appendChild(actions);
  }

  _renderOptionInputs() {
    const list = this.shadowRoot.getElementById('options-list');
    while (list.firstChild) list.removeChild(list.firstChild);
    for (let i = 0; i < this._optionCount; i++) {
      const row = document.createElement('div');
      row.className = 'form-row';
      const input = document.createElement('input');
      input.placeholder = 'Option ' + (i + 1);
      input.className = 'poll-option-input';
      row.appendChild(input);
      if (i >= 2) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'btn-danger';
        removeBtn.textContent = 'X';
        removeBtn.onclick = () => { this._optionCount--; this._renderOptionInputs(); };
        row.appendChild(removeBtn);
      }
      list.appendChild(row);
    }
  }

  async _handleCreate() {
    const q = this.shadowRoot.getElementById('poll-question');
    const inputs = this.shadowRoot.querySelectorAll('.poll-option-input');
    const question = q.value.trim();
    const options = Array.from(inputs).map(i => i.value.trim()).filter(Boolean);
    if (!question || options.length < 2) return;

    try {
      await this._bridge.request('create', { question, options });
      q.value = '';
      inputs.forEach(i => { i.value = ''; });
      this._optionCount = 2;
      this._renderOptionInputs();
      await this._loadPolls();
    } catch (e) {
      console.error('[PollApp] Create failed:', e);
    }
  }

  _renderPolls() {
    const container = this.shadowRoot.getElementById('polls-container');
    while (container.firstChild) container.removeChild(container.firstChild);

    if (this._polls.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No polls yet. Create one below!';
      container.appendChild(empty);
      return;
    }

    for (const poll of this._polls) {
      const r = this._results[poll.id];
      if (!r) continue;

      const card = document.createElement('div');
      card.className = 'poll-card';

      const question = document.createElement('div');
      question.className = 'poll-question';
      question.textContent = poll.question;
      if (poll.closed) {
        const badge = document.createElement('span');
        badge.className = 'closed-badge';
        badge.textContent = 'CLOSED';
        question.appendChild(badge);
      }
      card.appendChild(question);

      const meta = document.createElement('div');
      meta.className = 'poll-meta';
      meta.textContent = 'by ' + poll.createdBy + ' \u00B7 ' + r.totalVotes + ' vote' + (r.totalVotes !== 1 ? 's' : '');
      card.appendChild(meta);

      for (let i = 0; i < poll.options.length; i++) {
        const opt = document.createElement('div');
        opt.className = 'option' + (r.userVote != null ? ' voted' : '');
        const bar = document.createElement('div');
        bar.className = 'option-bar';

        const barBg = document.createElement('div');
        barBg.className = 'bar-bg';
        const barFill = document.createElement('div');
        const pct = r.totalVotes > 0 ? Math.round((r.votes[i].count / r.totalVotes) * 100) : 0;
        barFill.className = 'bar-fill ' + (r.userVote === i ? 'selected' : 'other');
        barFill.style.width = Math.max(pct, 0) + '%';
        barFill.textContent = poll.options[i];
        barBg.appendChild(barFill);
        bar.appendChild(barBg);

        const count = document.createElement('span');
        count.className = 'vote-count';
        count.textContent = pct + '%';
        bar.appendChild(count);

        opt.appendChild(bar);

        if (!poll.closed && r.userVote == null) {
          opt.style.cursor = 'pointer';
          const idx = i;
          opt.onclick = () => this._handleVote(poll.id, idx);
        }

        card.appendChild(opt);
      }

      // Close button for creator
      if (!poll.closed && poll.createdBy === this._bridge.user.username) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn-secondary';
        closeBtn.textContent = 'Close Poll';
        closeBtn.style.marginTop = '8px';
        closeBtn.onclick = () => this._handleClose(poll.id);
        card.appendChild(closeBtn);
      }

      container.appendChild(card);
    }
  }

  async _handleVote(pollId, optionIdx) {
    try {
      await this._bridge.request('vote', { pollId, optionIdx });
      const results = await this._bridge.request('results', { pollId });
      this._results[pollId] = results;
      this._renderPolls();
    } catch (e) {
      console.error('[PollApp] Vote failed:', e);
    }
  }

  async _handleClose(pollId) {
    try {
      await this._bridge.request('close', { pollId });
      await this._loadPolls();
    } catch (e) {
      console.error('[PollApp] Close failed:', e);
    }
  }

  disconnectedCallback() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }
}

customElements.define('room-app-poll', RoomAppPoll);
