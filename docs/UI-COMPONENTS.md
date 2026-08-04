# UI 组件库用法说明

本项目（AIStock）的界面交互元素统一封装在 `app/components/ui.tsx`，视觉样式全部由
`app/styles/globals.css` 中的语义化 class 驱动。新增页面或改造旧页面时，**优先复用以下组件**，
不要手写裸 `<button>` / `<input>` 或散落的 class（如 `primary-button` / `ghost-button`）。

---

## 布局与区块

### `SectionHeader`
页面/区块标题栏，支持副标题、说明、操作位。

| 属性 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `eyebrow` | `ReactNode` | — | 小标题（眉题） |
| `title` | `ReactNode` | — | 主标题 |
| `subtitle` | `ReactNode` | — | 副标题 |
| `desc` | `ReactNode` | — | 说明段落（`.section-header__desc`） |
| `number` | `ReactNode` | — | 序号标记 |
| `actions` | `ReactNode` | — | 右侧操作区（通常放 `Button`） |
| `layout` | `"split" \| "stack"` | `"split"` | 标题与操作横向/纵向排列 |
| `size` | `"sm" \| "md"` | `"md"` | 尺寸 |
| `as` | 标签名 | `"h3"` | 标题渲染的标签 |
| `bordered` | `boolean` | `false` | 是否显示底部分隔线 |

```tsx
<SectionHeader
  eyebrow="今天只处理重要的事"
  title="我的持仓"
  desc="这里只看需要你今天决策的事"
  actions={<Button variant="link" size="sm" onClick={() => navigate("trades")}>查看交易记录 →</Button>}
/>
```

### `Card` / `CardHeader`
统一的卡片容器与卡片标题栏。分析页、设置页面板均使用它。

```tsx
<Card className="analytics-panel">
  <CardHeader
    title="风险敞口"
    desc="按行业聚合的持仓占比"
    actions={<Button variant="ghost" size="sm" onClick={exportCsv}>导出</Button>}
  />
  {/* 卡片内容 */}
</Card>
```

- `Card`：`padded`(默认 `true` 内边距) / `inset` 两种修饰。
- `CardHeader`：`title`(必填) / `desc` / `actions`。

### `EmptyState`
空数据占位。

```tsx
<EmptyState icon={<Inbox />} title="还没有关注" hint="添加一只股票开始" action={<Button onClick={add}>添加</Button>} />
```

---

## 表单元素

### `Field`
表单字段容器，统一标签、必填星号、帮助文字。

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `label` | `ReactNode` | 字段标签 |
| `htmlFor` | `string` | 关联控件 id（可访问性） |
| `help` | `ReactNode` | 标签下方的帮助/提示文字 |
| `required` | `boolean` | 是否显示必填 `*` |
| `children` | `ReactNode` | 控件（`<Input>`/`<Textarea>`/`<Select>`） |

```tsx
<Field label="金额（元）" help="最多接受亏损对应的金额" required>
  <Input name="amount" type="number" step="0.01" />
</Field>
```

### `Input` / `Textarea` / `Select`
统一控件样式（渲染为 `.control`）。均为 `forwardRef`，直接接收原生属性。

```tsx
<Input name="price" type="number" min={0} step="any" placeholder="限价" required />
<Textarea name="note" maxLength={300} placeholder="写下你的计划" />
<Select name="status" defaultValue="研究中">
  <option>研究中</option>
  <option>等待条件</option>
</Select>
```

> 文件选择也用 `Input`：`<Input name="file" type="file" accept="application/pdf" />`

---

## 按钮

### `Button`
主操作按钮。**禁止**再使用裸 `<button>` 或 `primary-button` class。

| 属性 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `variant` | `"primary" \| "ghost" \| "subtle" \| "danger" \| "outline" \| "link"` | `"primary"` | 视觉变体 |
| `size` | `"sm" \| "md"` | `"md"` | 尺寸 |
| `block` | `boolean` | `false` | 占满整行 |
| `iconLeft` | `ReactNode` | — | 左侧图标 |
| `iconRight` | `ReactNode` | — | 右侧图标 |

其余原生 `<button>` 属性（`onClick`、`type`、`disabled`、`form` 等）透传。

```tsx
<Button variant="primary" iconLeft={<Plus size={16} />} onClick={onBuy}>记录买入</Button>
<Button variant="ghost" size="sm" onClick={ack}>我知道了</Button>
<Button variant="danger" type="submit">确认移出</Button>
<Button variant="link" onClick={toggle}>先看示例 →</Button>  {/* 文字链接型操作 */}
```

变体使用约定：
- `primary` — 页面/表单的主提交、主行动
- `ghost` — 次级操作、卡片内小操作
- `danger` — 删除/停用/危险确认
- `outline` / `subtle` — 需要低强调的备选
- `link` — 行内文字链接式跳转（如「查看交易记录 →」）

> 注意：`Button` 始终渲染 `<button>`。**需要跳转到 `href` 的链接**请直接用
> `<a className="btn btn--primary">链接文字</a>`（如「下载JSON备份」）。

### `IconButton`
纯图标按钮，必须提供 `label`（同时作为 `aria-label` 和 `title`）。

| 属性 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `label` | `string` | — | 无障碍标签（必填） |
| `variant` | `"ghost" \| "danger"` | `"ghost"` | 视觉变体 |

```tsx
<IconButton label="编辑条件" onClick={() => setEditing(s)}><PencilSimple size={16} /></IconButton>
<IconButton label="移出关注" variant="danger" onClick={() => setConfirming(s)}><Trash size={16} /></IconButton>
<IconButton label="关闭" onClick={onClose}>×</IconButton>
```

---

## 其它

### `Segmented<T>`
分段选择器（标签页式单选）。

```tsx
<Segmented
  value={tab}
  onChange={setTab}
  options={[{ value: "in", label: "转入" }, { value: "out", label: "转出" }]}
  block
/>
```

### `Tag`
标签/标记，可选可移除。

```tsx
<Tag tone="up">上涨</Tag>
<Tag tone="danger" onRemove={() => remove(tag)}>错误</Tag>
```
`tone`: `neutral | accent | up | down | warn | danger`

### `Badge`
状态徽标。`tone`: `neutral | accent | up | down | warn | danger`

### `Stat`
指标展示。`<Stat label="收益率" value="+12.3%" hint="较上周" />`

### `Spinner` / `Progress`
加载指示 / 进度条。

```tsx
<Spinner size={18} />
<Progress value={65} tone="accent" />
```

### `Modal`
弹窗容器（自带遮罩、点击遮罩关闭、Esc 关闭由调用方处理）。

```tsx
<Modal title="移出关注？" onClose={() => setConfirming(null)} footer={<Button>确认</Button>} size="sm">
  <p>确认要移出吗？</p>
</Modal>
```
`size`: `sm | md | lg`

---

## 设计令牌（globals.css `:root`）
颜色、圆角、阴影、动效统一走 CSS 变量，组件内部已使用，业务代码不要硬编码颜色值：

- 颜色：`--accent` / `--accent-ink` / `--up` / `--down` / `--warn` / `--red`
- 表面：`--surface` / `--surface-soft` / `--surface-strong`
- 线：`--line` / `--line-strong`
- 圆角：`--radius-card` / `--radius-control` / `--radius-pill`
- 阴影：`--shadow-card` / `--shadow-raised`
- 焦点：`--focus`
- 动效：`--ease` / `--dur`

---

## 移动端
- 断点 `760px`：卡片内边距收敛、弹窗底栏换行、触控区加大。
- 断点 `560px`：弹窗变为底部抽屉。
- 已尊重 `prefers-reduced-motion` 做动效降级。

---

## 迁移清单（已统一）
- 顶栏「记录买入」、`SectionHeader` 操作链接 → `Button`
- 登录页账号/密码 → `Input`
- 导入页预览/确认 → `Button`；文本域 → `Input`
- 交易/复盘弹窗表单 → `Field` + `Input`/`Textarea`
- 设置-账户（初始资金/流水）、关注编辑、公告发布表单 → `Field` + `Input`/`Select`/`Textarea`
- 首页提醒/待复盘、新手引导、关注卡片、交易记录、设置提醒、分析助手/策略按钮 → `Button`/`IconButton`
- 分析页图表卡 → `Card` + `CardHeader`
