import type { ModelProfile, ModelProvider } from "../types.js";

interface Props {
  profiles: ModelProfile[];
  onChange: (profiles: ModelProfile[]) => void;
  testingId: string | null;
  messages: Partial<Record<string, { text: string; error: boolean }>>;
  onTest: (profile: ModelProfile) => void;
}

const PROVIDERS: Array<{ value: ModelProvider; label: string }> = [
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "openai-chat", label: "OpenAI Chat" },
  { value: "chatgpt", label: "ChatGPT" },
];

function newProfile(index: number): ModelProfile {
  return {
    id: `model-${index + 1}`,
    provider: "anthropic-messages",
    model: "",
    apiUrl: "",
    apiKey: "",
  };
}

export default function ModelProfilesEditor({ profiles, onChange, testingId, messages, onTest }: Props) {
  const update = (index: number, patch: Partial<ModelProfile>) => {
    onChange(profiles.map((profile, i) => (i === index ? { ...profile, ...patch } : profile)));
  };

  const remove = (index: number) => {
    onChange(profiles.filter((_, i) => i !== index));
  };

  const add = () => {
    onChange([...profiles, newProfile(profiles.length)]);
  };

  return (
    <div className="model-profiles-editor">
      <div className="model-profiles-toolbar">
        <button type="button" onClick={add}>添加远程模型</button>
      </div>
      {profiles.length === 0 && <div className="model-profiles-empty">尚未配置远程模型。点击“添加远程模型”创建。</div>}
      {profiles.map((profile, index) => (
        <div key={`${profile.id}-${index}`} className="model-profile-card">
          <div className="model-profile-heading">
            <strong>{profile.name?.trim() || profile.model || profile.id}</strong>
            <button type="button" className="model-profile-remove" onClick={() => remove(index)} aria-label="删除模型">删除</button>
          </div>
          <div className="model-profile-grid">
            <label>
              <span>ID *</span>
              <input type="text" value={profile.id} onChange={(event) => update(index, { id: event.target.value })} />
            </label>
            <label>
              <span>名称</span>
              <input type="text" value={profile.name ?? ""} onChange={(event) => update(index, { name: event.target.value })} />
            </label>
            <label>
              <span>协议 *</span>
              <select value={profile.provider} onChange={(event) => update(index, { provider: event.target.value as ModelProvider })}>
                {PROVIDERS.map((provider) => <option key={provider.value} value={provider.value}>{provider.label}</option>)}
              </select>
            </label>
            <label>
              <span>模型 *</span>
              <input type="text" value={profile.model ?? ""} onChange={(event) => update(index, { model: event.target.value })} />
            </label>
            <label>
              <span>API URL *</span>
              <input type="text" value={profile.apiUrl ?? ""} onChange={(event) => update(index, { apiUrl: event.target.value })} />
            </label>
            <label>
              <span>API Key</span>
              <input type="password" value={profile.apiKey ?? ""} autoComplete="new-password" onChange={(event) => update(index, { apiKey: event.target.value })} />
            </label>
            <label>
              <span>单次回复 Token</span>
              <input type="number" value={profile.maxTokens ?? 0} onChange={(event) => update(index, { maxTokens: Number(event.target.value) || undefined })} />
            </label>
          </div>
          <div className="model-profile-test-row">
            <button type="button" className="model-profile-test" onClick={() => onTest(profile)} disabled={testingId !== null}>
              {testingId === profile.id ? "测试中..." : "测试"}
            </button>
            {messages[profile.id] && <span className={`config-message ${messages[profile.id]!.error ? "error" : ""}`}>{messages[profile.id]!.text}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
