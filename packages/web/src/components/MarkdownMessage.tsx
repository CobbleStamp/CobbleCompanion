/**
 * Renders an assistant reply as Markdown. The companion speaks in Markdown
 * (emphasis, lists, code, tables), so its replies show structured rather than as
 * a flat wall of asterisks. Links open in a new tab so following one never drops
 * the user out of the conversation.
 *
 * Safe by default: react-markdown does not render raw HTML (no `rehype-raw`), so
 * untrusted model output cannot inject markup. `remark-gfm` adds GitHub-flavoured
 * extras (tables, strikethrough, task lists, autolinks).
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownMessageProps {
  readonly content: string;
}

export function MarkdownMessage({ content }: MarkdownMessageProps): JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // `node` is react-markdown's AST handle — strip it so it never lands on
          // the DOM element, and force external links open in a new, isolated tab.
          a({ node, ...props }) {
            return <a {...props} target="_blank" rel="noopener noreferrer" />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
