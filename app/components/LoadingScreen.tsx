"use client";

/**
 * 品牌启动加载屏（首屏 Suspense fallback）。
 * 与全局「青蓝霓虹」设计语言一致：发光 logo + 骨架条 shimmer + 文案。
 * 替换原本裸的「正在加载…」文字，让首屏也有设计感。
 */
export function LoadingScreen({ label = "正在加载你的复盘工作台…" }: { label?: string }) {
  return (
    <div className="app-boot" role="status" aria-live="polite" aria-busy="true">
      <div className="app-boot__panel">
        <div className="app-boot__brand">
          <span className="app-boot__mark">股</span>
        </div>
        <div className="app-boot__name">我的复盘助手</div>
        <div className="app-boot__skeleton" aria-hidden="true">
          <span className="app-boot__bar" style={{ width: "82%" }} />
          <span className="app-boot__bar" style={{ width: "64%" }} />
          <span className="app-boot__bar" style={{ width: "73%" }} />
        </div>
        <div className="app-boot__label">{label}</div>
      </div>
    </div>
  );
}

export default LoadingScreen;
