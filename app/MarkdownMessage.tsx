/**
 * MarkdownMessage
 *
 * 把 AI 助手返回的 Markdown 文本渲染成结构化内容（标题/列表/表格/代码/
 * 引用等），同时兼顾兜底回答里大量使用裸换行（\n）的写法：通过
 * remark-breaks 把单个换行转成 <br>，避免段落被压成一行。
 *
 * 移动端优先：在 bubbles 里要求长串文本/数字/代号能换行，且小节标题更醒目。
 */
import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

type MarkdownMessageProps = {
  content: string;
  className?: string;
};

export const MarkdownMessage = memo(function MarkdownMessage({ content, className = "" }: MarkdownMessageProps) {
  return (
    <div className={`markdown-body ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          h1: ({ children }) => <h3 className="md-h md-h1">{children}</h3>,
          h2: ({ children }) => <h3 className="md-h md-h2">{children}</h3>,
          h3: ({ children }) => <h3 className="md-h md-h3">{children}</h3>,
          h4: ({ children }) => <h4 className="md-h md-h4">{children}</h4>,
          h5: ({ children }) => <h5 className="md-h md-h5">{children}</h5>,
          h6: ({ children }) => <h6 className="md-h md-h6">{children}</h6>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
          ),
        }}
      >{content}</ReactMarkdown>
    </div>
  );
});
