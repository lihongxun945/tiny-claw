import { useEffect, useRef, useState } from "react";
import { MessageCircleQuestion, X } from "lucide-react";
import type { RunView } from "../types.js";

export default function UserQuestion({ request, sessionId, onAnswer, onCancel }: {
  request: NonNullable<RunView["suspension"]>;
  sessionId: string;
  onAnswer: (id: string, answer: { selectedIds: string[]; text: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selectedIds, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const busy = useRef(false);
  const question = request.payload;
  useEffect(() => {
    const key = `question-shown:${sessionId}:${request.id}`;
    if (!sessionStorage.getItem(key)) {
      dialog.current?.showModal();
      sessionStorage.setItem(key, "1");
    }
  }, [sessionId, request.id]);
  const submit = async () => {
    if (busy.current || (!text.trim() && !selectedIds.length)) return;
    busy.current = true;
    setSubmitting(true);
    setError("");
    try { await onAnswer(request.id, { selectedIds, text }); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { busy.current = false; setSubmitting(false); }
  };
  return <section className="user-question" aria-label="待回答问题">
    <MessageCircleQuestion size={18} aria-hidden="true" />
    <div><span className="user-question-status">等待你回答</span><p>{question.question}</p></div>
    <button onClick={() => dialog.current?.showModal()}>回答问题</button>
    <dialog className="user-question-dialog" ref={dialog} aria-labelledby={`question-${request.id}`}>
      <header><h2 id={`question-${request.id}`}>{question.question}</h2><button className="user-question-close" title="稍后回答" aria-label="关闭问题弹窗" onClick={() => dialog.current?.close()}><X size={20} /></button></header>
      {question.context && <p>{question.context}</p>}
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {question.options.length > 0 && <fieldset disabled={submitting}><legend>请选择</legend>
          {question.options.map((option) => <label key={option.id}>
            <input type={question.type === "multiple_choice" ? "checkbox" : "radio"} name={`answer-${request.id}`} checked={selectedIds.includes(option.id)} onChange={(event) => setSelected(question.type === "single_choice" ? [option.id] : event.target.checked ? [...selectedIds, option.id] : selectedIds.filter((id) => id !== option.id))} />
            <span>{option.label}</span>
          </label>)}
        </fieldset>}
        <label className="user-question-text">{question.type === "text" ? "你的回答" : "补充或自定义回答"}
          <textarea value={text} maxLength={question.maxAnswerChars} disabled={submitting} onChange={(event) => setText(event.target.value)} rows={4} />
        </label>
        {error && <p role="alert">{error}</p>}
        <footer><button type="button" disabled={submitting} onClick={onCancel}>终止任务</button><button type="button" onClick={() => dialog.current?.close()}>稍后回答</button><button type="submit" disabled={submitting || (!text.trim() && !selectedIds.length)}>{submitting ? "提交中..." : "提交并继续"}</button></footer>
      </form>
    </dialog>
  </section>;
}
