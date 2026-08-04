import type { LocalModelId } from "../types.js";

export interface LocalModelDefinition {
  id: LocalModelId;
  name: string;
  description: string;
  size: string;
  family: "Qwen" | "Gemma";
  license: "Apache-2.0";
  recommendedMemoryGb: number;
  recommendedContextTokens: number;
  maxContextTokens: number;
  modelUri: string;
}

export const LOCAL_MODELS: readonly LocalModelDefinition[] = [
  {
    id: "qwen3.5-0.8b-q4",
    name: "Qwen3.5 0.8B Q4",
    description: "占用低，适合快速体验和自动测试。",
    size: "约 563 MB",
    family: "Qwen",
    license: "Apache-2.0",
    recommendedMemoryGb: 8,
    recommendedContextTokens: 32_768,
    maxContextTokens: 131_072,
    modelUri: "hf:ggml-org/Qwen3.5-0.8B-GGUF:Q4_0",
  },
  {
    id: "qwen3.5-2b-q4",
    name: "Qwen3.5 2B Q4",
    description: "轻量中文对话和简单工具任务。",
    size: "约 1.28 GB",
    family: "Qwen",
    license: "Apache-2.0",
    recommendedMemoryGb: 8,
    recommendedContextTokens: 32_768,
    maxContextTokens: 131_072,
    modelUri: "hf:unsloth/Qwen3.5-2B-GGUF:Q4_K_M",
  },
  {
    id: "qwen3.5-4b-q4",
    name: "Qwen3.5 4B Q4",
    description: "中文和 Agent 场景推荐。",
    size: "约 2.58 GB",
    family: "Qwen",
    license: "Apache-2.0",
    recommendedMemoryGb: 16,
    recommendedContextTokens: 32_768,
    maxContextTokens: 131_072,
    modelUri: "hf:unsloth/Qwen3.5-4B-GGUF:Q4_0",
  },
  {
    id: "qwen3.5-9b-q4",
    name: "Qwen3.5 9B Q4",
    description: "更强的推理和工具使用能力。",
    size: "约 5.68 GB",
    family: "Qwen",
    license: "Apache-2.0",
    recommendedMemoryGb: 16,
    recommendedContextTokens: 32_768,
    maxContextTokens: 131_072,
    modelUri: "hf:unsloth/Qwen3.5-9B-GGUF:Q4_K_M",
  },
  {
    id: "qwen3.5-27b-q4",
    name: "Qwen3.5 27B Q4",
    description: "高质量本地推理，资源占用较高。",
    size: "约 16.74 GB",
    family: "Qwen",
    license: "Apache-2.0",
    recommendedMemoryGb: 32,
    recommendedContextTokens: 32_768,
    maxContextTokens: 131_072,
    modelUri: "hf:unsloth/Qwen3.5-27B-GGUF:Q4_K_M",
  },
  {
    id: "qwen3.5-35b-a3b-q4",
    name: "Qwen3.5 35B-A3B Q4",
    description: "MoE 模型，激活参数较少但模型文件较大。",
    size: "约 22.02 GB",
    family: "Qwen",
    license: "Apache-2.0",
    recommendedMemoryGb: 32,
    recommendedContextTokens: 32_768,
    maxContextTokens: 131_072,
    modelUri: "hf:unsloth/Qwen3.5-35B-A3B-GGUF:Q4_K_M",
  },
  {
    id: "gemma-4-e2b-it-q4",
    name: "Gemma 4 E2B IT Q4",
    description: "Gemma 4 轻量版本，适合快速本地体验。",
    size: "约 2.84 GB",
    family: "Gemma",
    license: "Apache-2.0",
    recommendedMemoryGb: 8,
    recommendedContextTokens: 32_768,
    maxContextTokens: 131_072,
    modelUri: "hf:ggml-org/gemma-4-E2B-it-GGUF:Q4_0",
  },
  {
    id: "gemma-4-e4b-it-q4",
    name: "Gemma 4 E4B IT Q4",
    description: "适合笔记本和日常通用 Agent 任务。",
    size: "约 4.59 GB",
    family: "Gemma",
    license: "Apache-2.0",
    recommendedMemoryGb: 16,
    recommendedContextTokens: 32_768,
    maxContextTokens: 131_072,
    modelUri: "hf:ggml-org/gemma-4-E4B-it-GGUF:Q4_0",
  },
  {
    id: "gemma-4-12b-it-q4",
    name: "Gemma 4 12B IT Q4",
    description: "高质量通用、编码和多语言任务。",
    size: "约 7.22 GB",
    family: "Gemma",
    license: "Apache-2.0",
    recommendedMemoryGb: 16,
    recommendedContextTokens: 32_768,
    maxContextTokens: 262_144,
    modelUri: "hf:ggml-org/gemma-4-12B-it-GGUF:Q4_0",
  },
  {
    id: "gemma-4-26b-a4b-it-q4",
    name: "Gemma 4 26B-A4B IT Q4",
    description: "MoE 推荐版本，激活参数较少但需加载全部权重。",
    size: "约 14.62 GB",
    family: "Gemma",
    license: "Apache-2.0",
    recommendedMemoryGb: 32,
    recommendedContextTokens: 32_768,
    maxContextTokens: 262_144,
    modelUri: "hf:ggml-org/gemma-4-26B-A4B-it-GGUF:Q4_0",
  },
  {
    id: "gemma-4-31b-it-q4",
    name: "Gemma 4 31B IT Q4",
    description: "Gemma 4 高质量稠密版本，资源占用最高。",
    size: "约 17.99 GB",
    family: "Gemma",
    license: "Apache-2.0",
    recommendedMemoryGb: 32,
    recommendedContextTokens: 32_768,
    maxContextTokens: 262_144,
    modelUri: "hf:ggml-org/gemma-4-31B-it-GGUF:Q4_0",
  },
] as const;

export function getLocalModelDefinition(id: string): LocalModelDefinition {
  const model = LOCAL_MODELS.find((item) => item.id === id);
  if (!model) throw new Error(`不支持的本地模型: ${id}`);
  return model;
}

export function getLocalContextSize(modelId: string | undefined, configuredSize: number | undefined): number {
  const model = getLocalModelDefinition(modelId ?? "qwen3.5-4b-q4");
  if (!Number.isFinite(configuredSize) || !configuredSize) return model.recommendedContextTokens;
  return Math.min(Math.floor(configuredSize), model.maxContextTokens);
}
