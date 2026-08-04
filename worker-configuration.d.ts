declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    AI_API_KEY?: string;
    DEEPSEEK_API_KEY?: string;
    AI_PROVIDER?: string;
    AI_API_BASE?: string;
    AI_MODEL?: string;
    APP_USERNAME?: string;
    APP_PASSWORD?: string;
    APP_AUTH_SECRET?: string;
    MAIRUI_TOKEN?: string;
    STRATEGY_PUSH_TOKEN?: string;
    CRON_SECRET?: string;
  }
}
