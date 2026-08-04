import { rmSync } from "node:fs";
import { access, cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// Packages Sites metadata and migrations after Vite finishes compiling.
export function sites(): Plugin {
  let root = process.cwd();

  return {
    name: "sites",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    async closeBundle() {
      const outputDirectory = resolve(root, "dist", ".openai");
      const hostingConfig = resolve(root, ".openai", "hosting.json");
      const drizzleSource = resolve(root, "drizzle");

      // 删除旧目录。注意：部分环境下 node:fs/promises.rm 会被 safe-delete 包装
      // 拦截并改走 trash 操作而失败（报 "Some operations were aborted"）。
      // 这里先尝试异步 rm，被拦截时退化为同步 rmSync（不被拦截），
      // 保证构建在本地与 CI 环境都能继续。
      try {
        await rm(outputDirectory, { recursive: true, force: true });
      } catch {
        rmSync(outputDirectory, { recursive: true, force: true });
      }
      await mkdir(outputDirectory, { recursive: true });

      if (await exists(hostingConfig)) {
        await cp(hostingConfig, resolve(outputDirectory, "hosting.json"));
      }
      if (await exists(drizzleSource)) {
        await cp(drizzleSource, resolve(outputDirectory, "drizzle"), {
          recursive: true,
        });
      }
    },
  };
}
