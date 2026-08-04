import { env } from "cloudflare:workers";

export type AiProvider = "deepseek" | "openai";

export type AiConfig = {
  configured: boolean;
  provider: AiProvider;
  apiKey: string;
  apiBase: string;
  model: string;
};

// 运行时配置（来自 Worker env / wrangler .dev.vars）。
// 兼容旧字段 DEEPSEEK_API_KEY：未设置 AI_API_KEY 时回退到它。
// 通过环境变量即可切换模型源，无需改代码：
//   AI_PROVIDER=openai  AI_API_KEY=sk-xxx  AI_API_BASE=https://api.openai.com/v1  AI_MODEL=gpt-4o
export function getAiConfig(): AiConfig {
  const runtimeEnv = env as unknown as {
    AI_API_KEY?: string;
    DEEPSEEK_API_KEY?: string;
    AI_PROVIDER?: string;
    AI_API_BASE?: string;
    AI_MODEL?: string;
  };

  const apiKey = (runtimeEnv.AI_API_KEY ?? runtimeEnv.DEEPSEEK_API_KEY ?? "").trim();
  const provider: AiProvider = runtimeEnv.AI_PROVIDER === "openai" ? "openai" : "deepseek";
  const apiBase =
    runtimeEnv.AI_API_BASE?.trim() ||
    (provider === "openai" ? "https://api.openai.com/v1" : "https://api.deepseek.com");
  const model =
    runtimeEnv.AI_MODEL?.trim() ||
    (provider === "openai" ? "gpt-4o" : "deepseek-chat");

  return { configured: apiKey.length > 0, provider, apiKey, apiBase, model };
}
