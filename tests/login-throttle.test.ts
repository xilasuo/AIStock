import assert from "node:assert/strict";
import test from "node:test";
import {
  BASE_LOCK_MS,
  MAX_FAILURES_PER_USER,
  WINDOW_MS,
  __resetLoginThrottle,
  checkLoginAllowed,
  clientIpFrom,
  recordLoginFailure,
  recordLoginSuccess,
} from "../lib/auth/login-throttle";

test("未达阈值前允许继续尝试", () => {
  __resetLoginThrottle();
  const now = 1_000_000;
  for (let i = 0; i < MAX_FAILURES_PER_USER - 1; i += 1) {
    recordLoginFailure("alice", "1.1.1.1", now);
  }
  assert.equal(checkLoginAllowed("alice", "1.1.1.1", now).allowed, true);
});

test("达到阈值后锁定并给出重试等待时间", () => {
  __resetLoginThrottle();
  const now = 1_000_000;
  for (let i = 0; i < MAX_FAILURES_PER_USER; i += 1) {
    recordLoginFailure("bob", "2.2.2.2", now);
  }

  const decision = checkLoginAllowed("bob", "2.2.2.2", now);
  assert.equal(decision.allowed, false);
  assert.ok(decision.allowed === false && decision.retryAfterSeconds > 0);
});

test("锁定到期后重新放行", () => {
  __resetLoginThrottle();
  const now = 1_000_000;
  for (let i = 0; i < MAX_FAILURES_PER_USER; i += 1) {
    recordLoginFailure("carol", "3.3.3.3", now);
  }
  assert.equal(checkLoginAllowed("carol", "3.3.3.3", now).allowed, false);
  assert.equal(
    checkLoginAllowed("carol", "3.3.3.3", now + BASE_LOCK_MS + 1_000).allowed,
    true,
  );
});

test("换 IP 也拦得住针对同一账号的爆破", () => {
  __resetLoginThrottle();
  const now = 1_000_000;
  for (let i = 0; i < MAX_FAILURES_PER_USER; i += 1) {
    recordLoginFailure("dave", `10.0.0.${i}`, now);
  }
  // 用户名维度已锁定，即使来源 IP 全新也应拒绝。
  assert.equal(checkLoginAllowed("dave", "9.9.9.9", now).allowed, false);
});

test("用户名大小写不同不能绕过限流", () => {
  __resetLoginThrottle();
  const now = 1_000_000;
  for (let i = 0; i < MAX_FAILURES_PER_USER; i += 1) {
    recordLoginFailure("Erin", "4.4.4.4", now);
  }
  assert.equal(checkLoginAllowed("erin", "4.4.4.4", now).allowed, false);
  assert.equal(checkLoginAllowed("ERIN", "4.4.4.4", now).allowed, false);
});

test("登录成功后清空失败计数", () => {
  __resetLoginThrottle();
  const now = 1_000_000;
  for (let i = 0; i < MAX_FAILURES_PER_USER - 1; i += 1) {
    recordLoginFailure("frank", "5.5.5.5", now);
  }
  recordLoginSuccess("frank", "5.5.5.5");
  for (let i = 0; i < MAX_FAILURES_PER_USER - 1; i += 1) {
    recordLoginFailure("frank", "5.5.5.5", now);
  }
  assert.equal(checkLoginAllowed("frank", "5.5.5.5", now).allowed, true);
});

test("失败计数窗口过期后重新计数", () => {
  __resetLoginThrottle();
  const now = 1_000_000;
  for (let i = 0; i < MAX_FAILURES_PER_USER - 1; i += 1) {
    recordLoginFailure("grace", "6.6.6.6", now);
  }
  // 窗口外的失败属于新窗口，不应与旧失败累加触发锁定。
  const later = now + WINDOW_MS + 1;
  recordLoginFailure("grace", "6.6.6.6", later);
  assert.equal(checkLoginAllowed("grace", "6.6.6.6", later).allowed, true);
});

test("优先采用 Cloudflare 注入的真实客户端 IP", () => {
  const headers = new Headers({
    "cf-connecting-ip": "203.0.113.7",
    "x-forwarded-for": "1.2.3.4, 5.6.7.8",
  });
  assert.equal(clientIpFrom(headers), "203.0.113.7");

  assert.equal(
    clientIpFrom(new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })),
    "1.2.3.4",
  );
  assert.equal(clientIpFrom(new Headers()), "unknown");
});
