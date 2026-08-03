/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import * as schema from "../db/schema";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },

  /**
   * 提醒主动推送（离线兜底）：
   * 由 Cloudflare Cron Trigger 触发（需在 CF 侧配置，建议每 5 或 15 分钟一次）。
   * 分工：
   *  - 用户在线：前端每 5 分钟轮询并即时检查止损/止盈（页面内提醒），本 handler 不冲突。
   *  - 用户离线：本 handler 拉实时价、触达后经 Webhook 推送（企微/飞书/Slack/Bark）。
   * 粒度：15 分钟偏粗（止损/止盈价格敏感），建议收紧到 5 分钟；改后需在 CF 控制台同步。
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    try {
      const { drizzle } = await import("drizzle-orm/d1");
      const { checkAndNotifyAlerts } = await import("../lib/notify");
      const db = drizzle(env.DB, { schema, logger: false });
      ctx.waitUntil(checkAndNotifyAlerts(db));
    } catch (error) {
      console.error("scheduled alert check failed", error);
    }
  },
};

export default worker;
