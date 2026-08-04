import { execSync } from "child_process";

// Cloudflare Workers / Miniflare 沙箱里没有真实 child_process：
// execSync 被「挂了空壳函数」，调用即抛 "The child_process.execSync method is not implemented"。
// 只有真正的 Node.js（带 process.versions.node）才能直接 exec。
// 注意：typeof execSync === "function" 在沙箱里也是 true（空壳），不能用作判定。
const IS_REAL_NODE =
  typeof process !== "undefined" && !!process.versions?.node;

export const SUPPORTS_EXEC = IS_REAL_NODE;

// 本地引擎守护进程地址（真实 Node 进程，运行在 Workers 沙箱之外）
export const LOCAL_ENGINE_URL =
  process.env.LOCAL_ENGINE_URL || "http://127.0.0.1:8787";

/** 判定 exec 报错是否来自「沙箱未实现 child_process」 */
export function isExecNotImplemented(msg: string): boolean {
  return /not implemented|child_process/i.test(msg);
}

/**
 * 在 Workers / 边缘运行时把请求转发给本机真实 Node 守护进程。
 * 守护进程未启动或不可达时，返回清晰的可操作错误（而非底层崩溃信息）。
 */
export async function forwardToDaemon(
  pathname: string,
  init?: { method?: string; body?: string },
): Promise<Response> {
  try {
    const upstream = await fetch(`${LOCAL_ENGINE_URL}${pathname}`, {
      method: init?.method ?? "GET",
      headers: { "Content-Type": "application/json" },
      body: init?.body,
    });
    const data = (await upstream.json()) as Record<string, unknown>;
    return Response.json(data, { status: upstream.ok ? 200 : 502 });
  } catch {
    return Response.json(
      {
        ok: false,
        error:
          "当前运行环境（Cloudflare Workers / vinext 沙箱）无法直接执行本机 Python 引擎。\n" +
          "请在本机另开一个终端运行 `npm run engine`（启动本地引擎守护进程），\n" +
          "或直接在终端执行：python trading_agent/run_hub.py --prefetched trading_agent/prefetched.json --overrides '<你的配置>'。",
      },
      { status: 501 },
    );
  }
}

/**
 * 跨平台探测可用的 Python 解释器。
 * 优先级：环境变量 PYTHON_PATH > python3 > python > py（Windows 启动器）。
 * 仅在 SUPPORTS_EXEC 为 true 的真实 Node 环境调用。
 */
export function resolvePython(): string {
  if (process.env.PYTHON_PATH) return process.env.PYTHON_PATH;
  const candidates = ["python3", "python", "py"];
  for (const c of candidates) {
    try {
      execSync(`"${c}" --version`, { timeout: 8_000, stdio: "ignore" });
      return c;
    } catch {
      // 该候选不可用，尝试下一个
    }
  }
  return "python3"; // 兜底
}
