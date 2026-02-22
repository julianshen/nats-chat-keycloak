export const styles = `
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
  .option { margin-bottom: 6px; cursor: default; }
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
