import { useState } from 'react';

interface Props {
  onSubmit: (question: string, options: string[]) => Promise<void>;
}

export function CreateForm({ onSubmit }: Props) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);

  const addOption = () => setOptions((prev) => [...prev, '']);

  const removeOption = (index: number) => {
    setOptions((prev) => prev.filter((_, i) => i !== index));
  };

  const updateOption = (index: number, value: string) => {
    setOptions((prev) => prev.map((v, i) => (i === index ? value : v)));
  };

  const handleSubmit = async () => {
    const q = question.trim();
    const opts = options.map((o) => o.trim()).filter(Boolean);
    if (!q || opts.length < 2) return;

    await onSubmit(q, opts);
    setQuestion('');
    setOptions(['', '']);
  };

  return (
    <div className="create-form">
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
        Create a Poll
      </div>
      <div className="form-row">
        <input
          placeholder="Ask a question..."
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
      </div>
      {options.map((opt, i) => (
        <div key={i} className="form-row">
          <input
            placeholder={`Option ${i + 1}`}
            value={opt}
            onChange={(e) => updateOption(i, e.target.value)}
          />
          {i >= 2 && (
            <button className="btn-danger" onClick={() => removeOption(i)}>
              X
            </button>
          )}
        </div>
      ))}
      <div className="form-row" style={{ marginTop: 4 }}>
        <button className="add-option" onClick={addOption}>
          + Add option
        </button>
        <div style={{ flex: 1 }} />
        <button className="btn-primary" onClick={handleSubmit}>
          Create Poll
        </button>
      </div>
    </div>
  );
}
