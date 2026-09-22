import { useState, useRef, useEffect } from "react";
import { fetchChatCommands, fetchContextSnapshot } from "../lib/api.js";
import type { ChatCommand, ContextSnapshot, ContextTokenUsage, PermissionMode } from "../types.js";
import type { ExecutionMode, ModelInfo } from "../types.js";
import ContextViewer from "./ContextViewer.js";

interface Props {
  isStopping?: boolean;
  onSend: (text: string, files: File[]) => void;
  onStop: () => void;
  disabled: boolean;
  executionMode: ExecutionMode;
  onExecutionModeChange: (mode: ExecutionMode) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  permissionSaving?: boolean;
  permissionError?: string;
  activeSessionId: string | null;
  contextUsage?: ContextTokenUsage;
  models: ModelInfo[];
  currentModelId?: string | null;
  onModelChange: (modelId: string) => void;
  modelError?: string;
}

export default function ChatInput({
  onSend,
  onStop,
  isStopping,
  disabled,
  permissionMode,
  onPermissionModeChange,
  permissionSaving = false,
  permissionError,
  activeSessionId,
  contextUsage,
  models,
  currentModelId,
  onModelChange,
  modelError,
}: Props) {
  const [text, setText] = useState("");
  const [commands, setCommands] = useState<ChatCommand[]>([]);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [autocompleteDismissed, setAutocompleteDismissed] = useState(false);
  const [images, setImages] = useState<Array<{ file: File; previewUrl: string }>>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef(images);
  const isComposingRef = useRef(false);
  const [snapshot, setSnapshot] = useState<ContextSnapshot | null>(null);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [snapshotLoading, setSnapshotLoading] = useState(false);

  useEffect(() => {
    fetchChatCommands().then(setCommands).catch(() => setCommands([]));
  }, []);

  useEffect(() => {
    setSnapshot(null);
    setSnapshotOpen(false);
    if (activeSessionId) fetchContextSnapshot(activeSessionId).then(setSnapshot).catch(() => setSnapshot(null));
  }, [activeSessionId]);

  useEffect(() => {
    if (!disabled) textareaRef.current?.focus();
  }, [disabled]);

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  useEffect(() => () => {
    for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
  }, []);

  const commandQuery = /^\/([^\s]*)$/.exec(text)?.[1].toLowerCase();
  const matchingCommands = commandQuery === undefined
    ? []
    : commands.filter((command) => (
      command.name.toLowerCase().startsWith(commandQuery)
      || command.aliases.some((alias) => alias.toLowerCase().startsWith(commandQuery))
    ));
  const showAutocomplete = !disabled
    && !autocompleteDismissed
    && commandQuery !== undefined
    && matchingCommands.length > 0;

  const fillCommand = (command: ChatCommand) => {
    const hasArguments = /\s/.test(command.usage.trim());
    setText(hasArguments ? `/${command.name} ` : `/${command.name}`);
    setAutocompleteDismissed(true);
    textareaRef.current?.focus();
  };

  const handleSend = () => {
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0) || disabled) return;
    onSend(trimmed, images.map((image) => image.file));
    for (const image of images) URL.revokeObjectURL(image.previewUrl);
    setText("");
    setImages([]);
  };

  const addImages = (files: File[]) => {
    const accepted = files
      .filter((file) => ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type))
      .map((file) => ({ file, previewUrl: URL.createObjectURL(file) }));
    setImages((current) => [...current, ...accepted]);
  };

  const removeImage = (index: number) => {
    setImages((current) => {
      const target = current[index];
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((_, itemIndex) => itemIndex !== index);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = e.nativeEvent as KeyboardEvent;
    if (isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) return;

    if (showAutocomplete) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedCommandIndex((index) => (index + 1) % matchingCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedCommandIndex((index) => (index - 1 + matchingCommands.length) % matchingCommands.length);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAutocompleteDismissed(true);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        fillCommand(matchingCommands[selectedCommandIndex] ?? matchingCommands[0]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 120) + "px";
    }
  };

  const openContext = async () => {
    if (!activeSessionId) return;
    setSnapshotLoading(true);
    try {
      const latest = await fetchContextSnapshot(activeSessionId);
      setSnapshot(latest);
      if (latest) setSnapshotOpen(true);
    } finally {
      setSnapshotLoading(false);
    }
  };

  const visibleUsage = contextUsage ?? snapshot?.usage;

  const effectiveModelId = currentModelId && models.some((model) => model.id === currentModelId)
    ? currentModelId
    : (models[0]?.id ?? "");

  return (
    <div className="chat-input">
      <div className="composer">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSelectedCommandIndex(0);
            setAutocompleteDismissed(false);
          }}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
          }}
          onInput={handleInput}
          onPaste={(event) => {
            const pastedImages = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
            if (pastedImages.length > 0) {
              event.preventDefault();
              addImages(pastedImages);
            }
          }}
          placeholder="输入消息，或按 / 使用命令"
          disabled={disabled}
          rows={1}
          aria-controls={showAutocomplete ? "chat-command-autocomplete" : undefined}
          aria-expanded={showAutocomplete}
        />
        {showAutocomplete && (
          <div id="chat-command-autocomplete" className="command-autocomplete" role="listbox" aria-label="聊天命令">
            {matchingCommands.map((command, index) => (
              <button
                key={command.name}
                type="button"
                role="option"
                aria-selected={index === selectedCommandIndex}
                className={index === selectedCommandIndex ? "selected" : ""}
                onMouseDown={(event) => {
                  event.preventDefault();
                  fillCommand(command);
                }}
                onMouseEnter={() => setSelectedCommandIndex(index)}
              >
                <span className="command-name">/{command.name}</span>
                <span className="command-description">{command.description}</span>
                <span className="command-usage">{command.usage}</span>
              </button>
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div className="pending-images" aria-label="待发送图片">
            {images.map((image, index) => (
              <div className="pending-image" key={`${image.file.name}-${image.file.lastModified}-${index}`}>
                <img src={image.previewUrl} alt={image.file.name} />
                <button
                  type="button"
                  aria-label={`移除 ${image.file.name}`}
                  onClick={() => removeImage(index)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-footer">
          <div className="composer-tools">
            <button
              type="button"
              className="attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              aria-label="上传图片"
              title="上传图片"
            >
              ＋
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={(event) => {
                addImages(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            <label className="permission-mode-select" title={permissionError || "工具自定义权限配置优先"}>
              <select
                aria-label="审批模式"
                value={permissionMode}
                onChange={(event) => onPermissionModeChange(event.target.value as PermissionMode)}
                disabled={disabled || permissionSaving}
              >
                <option value="auto">自动审批</option>
                <option value="ask">总是询问</option>
                <option value="allow">全部允许</option>
              </select>
            </label>
            {permissionError && <span className="permission-mode-error">{permissionError}</span>}
          </div>
          <div className="composer-actions">
            {visibleUsage && <button
              type="button"
              className={`context-usage-trigger ${visibleUsage && visibleUsage.percent >= 80 ? "danger" : visibleUsage && visibleUsage.percent >= 60 ? "warning" : ""}`}
              disabled={!activeSessionId || snapshotLoading || !visibleUsage}
              aria-busy={snapshotLoading}
              title="查看上下文统计"
              onClick={() => void openContext()}
            >
              {`上下文 ${visibleUsage.percent}%`}
            </button>}
            {models.length > 0 && (
              <label className="chat-model-picker" title={modelError || "切换当前会话使用的模型"}>
                <select
                  aria-label="模型切换"
                  value={effectiveModelId}
                  onChange={(event) => onModelChange(event.target.value)}
                  disabled={!activeSessionId || disabled}
                  className={modelError ? "model-error" : undefined}
                >
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>{model.name?.trim() || model.model || model.id}</option>
                  ))}
                </select>
              </label>
            )}
            {disabled ? (
              <button className="stop-btn" disabled={isStopping} onClick={onStop}>{isStopping ? "正在停止..." : "停止"}</button>
            ) : (
              <button onClick={handleSend} disabled={!text.trim() && images.length === 0} aria-label="↑">↑</button>
            )}
          </div>
        </div>
      </div>
      {snapshotOpen && snapshot && <ContextViewer snapshot={snapshot} onClose={() => setSnapshotOpen(false)} />}
    </div>
  );
}
