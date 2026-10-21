import React, { useEffect, useRef, useState } from 'react';

// In-page dialogs replacing window.alert/confirm/prompt: they match the app,
// work in in-app browsers (LINE) that block native pop-ups, and let one
// dialog ask several things at once (reason + choice + checkbox). Callers
// await the answer; <DialogHost/> (mounted once in App) renders the queue.

export interface DialogOptions {
  title?: string;
  message: string;
  input?: { label?: string; placeholder?: string; defaultValue?: string; required?: boolean; type?: 'text' | 'number' };
  choices?: { value: string; label: string }[]; // radio options; first is preselected
  checkbox?: { label: string; defaultChecked?: boolean };
  okLabel?: string;
  cancelLabel?: string | null; // null = no cancel button (plain message)
  danger?: boolean;
}

export interface DialogResult { text: string; choice?: string; checked: boolean }

interface Pending { id: number; opts: DialogOptions; resolve: (r: DialogResult | null) => void }

const queue: Pending[] = [];
let nextId = 1;
let wake: (() => void) | null = null;

export function dialog(opts: DialogOptions): Promise<DialogResult | null> {
  return new Promise(resolve => {
    queue.push({ id: nextId++, opts, resolve });
    wake?.();
  });
}

// A message with an OK button. Fire-and-forget, like alert() was.
export function notify(message: string, title?: string): void {
  void dialog({ message, title, cancelLabel: null });
}

// Yes/no question.
export async function ask(message: string, opts: { title?: string; okLabel?: string; cancelLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  return (await dialog({ message, ...opts })) !== null;
}

// A text answer, or null when cancelled. required: an empty answer can't be sent.
export async function askText(message: string, opts: { title?: string; defaultValue?: string; placeholder?: string; required?: boolean; okLabel?: string } = {}): Promise<string | null> {
  const r = await dialog({
    message, title: opts.title, okLabel: opts.okLabel,
    input: { defaultValue: opts.defaultValue, placeholder: opts.placeholder, required: opts.required ?? true }
  });
  return r ? r.text.trim() : null;
}

export function DialogHost() {
  const [current, setCurrent] = useState<Pending | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    wake = () => setTick(t => t + 1);
    return () => { wake = null; };
  }, []);

  // Show the next queued dialog once the current one is answered.
  useEffect(() => {
    if (!current && queue.length) setCurrent(queue.shift()!);
  }, [tick, current]);

  if (!current) return null;
  // Keyed per dialog: each one starts with its own fresh answer state.
  return <DialogBox key={current.id} pending={current} onDone={() => setCurrent(null)} />;
}

function DialogBox({ pending, onDone }: { pending: Pending; onDone: () => void; key?: number }) {
  const { opts } = pending;
  const [text, setText] = useState(opts.input?.defaultValue ?? '');
  const [choice, setChoice] = useState<string | undefined>(opts.choices?.[0]?.value);
  const [checked, setChecked] = useState(!!opts.checkbox?.defaultChecked);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  const blocked = !!opts.input?.required && !text.trim();
  const close = (result: DialogResult | null) => {
    pending.resolve(result);
    onDone(); // the host shows the next one
  };
  const submit = () => { if (!blocked) close({ text, choice, checked }); };
  const cancel = () => close(opts.cancelLabel === null ? { text: '', checked: false } : null);

  // Focus moves into the dialog and comes back to whatever opened it.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    (opts.input ? inputRef.current : okRef.current)?.focus();
    return () => { opener?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape works wherever focus is, and Tab stays inside the dialog, so
  // Enter can't press a button on the page behind it.
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); cancelRef.current(); return; }
      if (e.key !== 'Tab' || !boxRef.current) return;
      const items = Array.from(boxRef.current.querySelectorAll('input, button:not([disabled])')) as HTMLElement[];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      const inside = boxRef.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="fixed inset-0 z-[100] bg-slate-900/50 flex items-center justify-center p-4">
      <div ref={boxRef} id="app-dialog" role="dialog" aria-modal="true" aria-labelledby={opts.title ? 'app-dialog-title' : undefined} aria-describedby="app-dialog-message"
        className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5 space-y-4 text-sm text-slate-800">
        {opts.title && <h3 id="app-dialog-title" className="font-bold text-base">{opts.title}</h3>}
        <p id="app-dialog-message" className="whitespace-pre-line leading-relaxed max-h-[50vh] overflow-y-auto">{opts.message}</p>
        {opts.input && (
          <label className="block space-y-1">
            {opts.input.label && <span className="text-xs text-slate-600">{opts.input.label}</span>}
            <input
              id="app-dialog-input"
              ref={inputRef}
              type={opts.input.type || 'text'}
              value={text}
              placeholder={opts.input.placeholder}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit(); }}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-base"
            />
          </label>
        )}
        {opts.choices && (
          <div className="space-y-2">
            {opts.choices.map(c => (
              <label key={c.value} className={`flex items-center gap-2 border rounded-lg px-3 py-2 cursor-pointer ${choice === c.value ? 'border-emerald-600 bg-emerald-50' : 'border-slate-200'}`}>
                <input type="radio" name="app-dialog-choice" value={c.value} checked={choice === c.value} onChange={() => setChoice(c.value)} />
                <span>{c.label}</span>
              </label>
            ))}
          </div>
        )}
        {opts.checkbox && (
          <label className="flex items-center gap-2 cursor-pointer">
            <input id="app-dialog-check" type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />
            <span>{opts.checkbox.label}</span>
          </label>
        )}
        <div className="flex justify-end gap-2 pt-1">
          {opts.cancelLabel !== null && (
            <button id="app-dialog-cancel" type="button" onClick={cancel} className="px-4 py-2 rounded-lg border border-slate-300 hover:bg-slate-50 font-bold">
              {opts.cancelLabel || 'ยกเลิก'}
            </button>
          )}
          <button
            id="app-dialog-ok"
            ref={okRef}
            type="button"
            disabled={blocked}
            onClick={submit}
            className={`px-4 py-2 rounded-lg text-white font-bold disabled:opacity-40 ${opts.danger ? 'bg-rose-600 hover:bg-rose-500' : 'bg-emerald-600 hover:bg-emerald-500'}`}
          >
            {opts.okLabel || 'ตกลง'}
          </button>
        </div>
      </div>
    </div>
  );
}
