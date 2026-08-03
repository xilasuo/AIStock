/**
 * 设计系统基础组件（Design-system primitives）
 *
 * 目的：把页面中反复出现、但过去用多种不同 class 书写的同类内容
 * （区块标题、状态标签、统计块）收敛到单一实现，避免“风格各异”。
 * 所有视觉令牌均来自 globals.css 的 :root 变量，不在组件内硬编码颜色。
 */
import { forwardRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes, type ReactNode } from "react";
import { Search } from "lucide-react";

/* ------------------------------------------------------------------ */
/* SectionHeader                                                        */
/* 统一了原先的 .panel-header / .card-title / .evidence-heading /       */
/* .assistant-heading / .sector-heatmap-head / .chart-heading /         */
/* .coach-head / .beginner-copy / .quick-title /                       */
/* .portfolio-overview-head / .page-intro / .search-hero 等标题写法。  */
/* ------------------------------------------------------------------ */
type SectionHeaderProps = {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  desc?: ReactNode;
  number?: string;
  actions?: ReactNode;
  layout?: "split" | "stack";
  size?: "md" | "lg" | "xl";
  as?: "h2" | "h3";
  bordered?: boolean;
};

export function SectionHeader({
  eyebrow,
  title,
  subtitle,
  desc,
  number,
  actions,
  layout = "split",
  size = "md",
  as = "h3",
  bordered = false,
}: SectionHeaderProps) {
  const Title = as;
  return (
    <header
      className={[
        "section-header",
        `section-header--${layout}`,
        `section-header--${size}`,
        bordered ? "section-header--bordered" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="section-header__main">
        {number && <span className="section-header__num">{number}</span>}
        <div className="section-header__text">
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <Title className="section-header__title">{title}</Title>
          {subtitle && <p className="section-header__subtitle">{subtitle}</p>}
          {desc && <p className="section-header__desc">{desc}</p>}
        </div>
      </div>
      {actions && <div className="section-header__actions">{actions}</div>}
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Badge                                                                */
/* 统一了原先的 .demo-label / .watch-state / .confidence /              */
/* .holding-label / .assistant-context / .side 等状态/标签药丸。        */
/* ------------------------------------------------------------------ */
type BadgeTone = "neutral" | "accent" | "red" | "green" | "amber" | "inverse";
type BadgeProps = {
  children: ReactNode;
  tone?: BadgeTone;
  square?: boolean;
  className?: string;
  title?: string;
};

export function Badge({
  children,
  tone = "neutral",
  square = false,
  className = "",
  title,
}: BadgeProps) {
  return (
    <span
      title={title}
      className={[
        "badge",
        `badge--${tone}`,
        square ? "badge--square" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Stat                                                                 */
/* 统一了原先的 .portfolio-metrics / .behavior-grid / .fund-facts       */
/* 等“统计块”网格里的子项写法。                                         */
/* ------------------------------------------------------------------ */
type StatProps = {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
};

export function Stat({ label, value, hint, className = "" }: StatProps) {
  return (
    <div className={`stat ${className}`.trim()}>
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      {hint && <span className="stat__hint">{hint}</span>}
    </div>
  );
}

/* ============================================================
   通用 UI 组件库（可复用 · 风格统一）
   所有视觉表现由 globals.css 中的语义类驱动，便于全局保持一致。
   ============================================================ */

type ButtonVariant = "primary" | "ghost" | "subtle" | "danger" | "outline" | "link";
type ButtonSize = "sm" | "md";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  block = false,
  iconLeft,
  iconRight,
  className = "",
  children,
  ...rest
}: ButtonProps) {
  const cls = [
    "btn",
    `btn--${variant}`,
    size === "sm" ? "btn--sm" : "",
    block ? "btn--block" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={cls} {...rest}>
      {iconLeft && <span className="btn__icon">{iconLeft}</span>}
      {children}
      {iconRight && <span className="btn__icon">{iconRight}</span>}
    </button>
  );
}

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  variant?: "ghost" | "subtle" | "danger";
}

export function IconButton({
  label,
  variant = "ghost",
  className = "",
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`icon-btn icon-btn--${variant} ${className}`.trim()}
      {...rest}
    >
      {children}
    </button>
  );
}

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  padded?: boolean;
  inset?: boolean;
}

export function Card({
  padded = true,
  inset = false,
  className = "",
  children,
  ...rest
}: CardProps) {
  const cls = [
    "card",
    padded ? "card--padded" : "",
    inset ? "card--inset" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  desc,
  actions,
  className = "",
}: {
  title: React.ReactNode;
  desc?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`card__header ${className}`.trim()}>
      <div className="card__heading">
        <div className="card__title">{title}</div>
        {desc && <div className="card__desc">{desc}</div>}
      </div>
      {actions && <div className="card__actions">{actions}</div>}
    </div>
  );
}

interface FieldProps {
  label?: React.ReactNode;
  htmlFor?: string;
  help?: React.ReactNode;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function Field({
  label,
  htmlFor,
  help,
  required,
  children,
  className = "",
}: FieldProps) {
  return (
    <label className={`field ${className}`.trim()} htmlFor={htmlFor}>
      {label && (
        <span className="field__label">
          {label}
          {required && <span className="field__req">*</span>}
        </span>
      )}
      {children}
      {help && <span className="field__help">{help}</span>}
    </label>
  );
}

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function Input({ className = "", ...rest }, ref) {
  return <input ref={ref} className={`control ${className}`.trim()} {...rest} />;
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className = "", ...rest }, ref) {
  return (
    <textarea ref={ref} className={`control control--area ${className}`.trim()} {...rest} />
  );
});

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className = "", children, ...rest }, ref) {
  return (
    <select ref={ref} className={`control control--select ${className}`.trim()} {...rest}>
      {children}
    </select>
  );
});

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: React.ReactNode }[];
  size?: "sm" | "md";
  block?: boolean;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  block = false,
}: SegmentedProps<T>) {
  return (
    <div
      className={`segmented ${size === "sm" ? "segmented--sm" : ""} ${
        block ? "segmented--block" : ""
      }`.trim()}
      role="tablist"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          className={`segmented__item ${o.value === value ? "is-active" : ""}`.trim()}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  hint?: React.ReactNode;
  action?: React.ReactNode;
}

export function EmptyState({ icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state__icon">{icon}</div>}
      <div className="empty-state__title">{title}</div>
      {hint && <div className="empty-state__hint">{hint}</div>}
      {action && <div className="empty-state__action">{action}</div>}
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <span
      className="spinner"
      style={{ width: size, height: size }}
      role="status"
      aria-label="加载中"
    />
  );
}

export function Progress({
  value,
  max = 100,
  tone = "accent",
}: {
  value: number;
  max?: number;
  tone?: "accent" | "up" | "down" | "warn";
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemax={max}>
      <span
        className={`progress__bar progress__bar--${tone}`.trim()}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function Tag({
  children,
  tone = "neutral",
  onRemove,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "accent" | "up" | "down" | "warn" | "danger";
  onRemove?: () => void;
}) {
  return (
    <span className={`tag tag--${tone}`.trim()}>
      {children}
      {onRemove && (
        <button type="button" className="tag__x" aria-label="移除" onClick={onRemove}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      )}
    </span>
  );
}

export function Divider({ className = "" }: { className?: string }) {
  return <div className={`divider ${className}`.trim()} />;
}

export function LoadingState({
  label = "加载中…",
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div className={`loading-state ${className}`.trim()} role="status" aria-live="polite">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

interface ModalProps {
  title?: React.ReactNode;
  eyebrow?: string;
  onClose?: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
  closeLabel?: string;
}

export function Modal({
  title,
  eyebrow,
  onClose,
  children,
  footer,
  size = "md",
  closeLabel = "关闭",
}: ModalProps) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`modal modal--${size}`.trim()}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        {title !== undefined && (
          <header>
            <div>
              {eyebrow && <span className="modal__eyebrow">{eyebrow}</span>}
              <h2>{title}</h2>
            </div>
            {onClose && (
              <button type="button" aria-label={closeLabel} onClick={onClose}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            )}
          </header>
        )}
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ConfirmDialog（确认弹窗）                                            */
/* 封装「注销确认」「移出关注」等二元确认弹窗，消除手写 modal-backdrop。  */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* StockSearch（股票搜索 / 选择框）                                     */
/* 通用「输入代码或名称 → 提交分析或选中」输入框，可选联想下拉。        */
/* 联想数据由调用方通过 suggestions 注入（如关注列表 + 最近分析合并），  */
/* 组件本身不持有股票全量列表，保持轻量、可复用。                       */
/* ------------------------------------------------------------------ */
export interface StockSuggestion {
  symbol: string;
  name?: string;
}

export function StockSearch({
  value,
  onChange,
  onSubmit,
  onSelect,
  loading = false,
  suggestions = [],
  submitLabel = "开始分析",
  loadingLabel = "正在获取数据…",
  placeholder = "例如 600519、贵州茅台",
  compact = false,
  className = "",
  inputRef,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (query: string) => void;
  onSelect?: (symbol: string) => void;
  loading?: boolean;
  suggestions?: StockSuggestion[];
  submitLabel?: string;
  loadingLabel?: string;
  placeholder?: string;
  compact?: boolean;
  className?: string;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const [open, setOpen] = useState(false);
  const list = open ? suggestions : [];

  const pick = (symbol: string) => {
    onChange(symbol);
    setOpen(false);
    onSelect?.(symbol);
  };

  return (
    <form
      className={`stock-search ${compact ? "compact" : ""} ${className}`.trim()}
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) onSubmit(value.trim());
      }}
    >
      <span className="search-icon"><Search size={21} /></span>
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        placeholder={placeholder}
        aria-label="股票代码或名称"
        autoComplete="off"
      />
      <Button variant="primary" type="submit" disabled={loading || !value.trim()}>
        {loading ? loadingLabel : submitLabel}
      </Button>
      {list.length > 0 && (
        <ul className="stock-search__suggestions" role="listbox">
          {list.map((item) => (
            <li key={item.symbol}>
              <button
                type="button"
                className="stock-search__option"
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(item.symbol);
                }}
              >
                <span className="stock-search__code">{item.symbol}</span>
                {item.name && <span className="stock-search__name">{item.name}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

export function ConfirmDialog({
  open,
  eyebrow,
  title,
  message,
  confirmLabel = "确认",
  cancelLabel = "取消",
  tone = "primary",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  eyebrow?: string;
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "primary" | "danger" | "warn";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <Modal
      eyebrow={eyebrow}
      title={title}
      onClose={onCancel}
      size="sm"
      footer={
        <div className="modal__footer-actions">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${tone === "danger" ? "btn--danger" : tone === "warn" ? "btn--warn" : "btn--primary"}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      }
    >
      {message && <p className="modal__message">{message}</p>}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Banner（Callout / 提示条）                                            */
/* 统一了原先散落的 .error-banner / .hint / .price-disclaimer /          */
/* .condition-hint 等提示类写法。tone 控制语义色，可选关闭与操作。       */
/* ------------------------------------------------------------------ */
type BannerTone = "info" | "warn" | "danger" | "success";

export function Banner({
  tone = "info",
  title,
  children,
  icon,
  action,
  onDismiss,
}: {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className={`banner banner--${tone}`} role={tone === "danger" ? "alert" : "status"}>
      {icon && <span className="banner__icon" aria-hidden="true">{icon}</span>}
      <div className="banner__body">
        {title && <p className="banner__title">{title}</p>}
        {children && <div className="banner__content">{children}</div>}
      </div>
      {action && <div className="banner__action">{action}</div>}
      {onDismiss && (
        <button type="button" className="banner__close" aria-label="关闭" onClick={onDismiss}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Hint（说明文字）                                                     */
/* 统一了 .hint / .condition-hint / .price-disclaimer 等小号说明。      */
/* ------------------------------------------------------------------ */
export function Hint({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warn" | "danger" }) {
  return <p className={`hint hint--${tone}`}>{children}</p>;
}
