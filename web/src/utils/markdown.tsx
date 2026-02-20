import React from 'react';

/**
 * Lightweight markdown-to-React renderer for chat messages.
 * Supports: bold, italic, strikethrough, inline code, code blocks,
 * links, unordered/ordered lists, blockquotes, and @mentions.
 * No external dependencies.
 */

const mdStyles: Record<string, React.CSSProperties> = {
  bold: { fontWeight: 700 },
  italic: { fontStyle: 'italic' },
  strike: { textDecoration: 'line-through', opacity: 0.7 },
  inlineCode: {
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
    fontSize: '12px',
    background: 'rgba(99,102,241,0.15)',
    color: '#e2e8f0',
    padding: '1px 5px',
    borderRadius: '3px',
  },
  codeBlock: {
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
    fontSize: '12px',
    background: '#1e293b',
    color: '#e2e8f0',
    padding: '10px 12px',
    borderRadius: '6px',
    overflowX: 'auto' as const,
    whiteSpace: 'pre' as const,
    margin: '4px 0',
    border: '1px solid #334155',
    display: 'block',
    lineHeight: 1.5,
  },
  link: {
    color: '#60a5fa',
    textDecoration: 'underline',
    cursor: 'pointer',
  },
  blockquote: {
    borderLeft: '3px solid #475569',
    paddingLeft: '10px',
    margin: '4px 0',
    color: '#94a3b8',
  },
  list: {
    margin: '4px 0',
    paddingLeft: '20px',
  },
  mentionSelf: {
    background: 'rgba(245,158,11,0.2)',
    color: '#fbbf24',
    borderRadius: '3px',
    padding: '0 2px',
  },
  mentionOther: {
    background: 'rgba(99,102,241,0.15)',
    color: '#a5b4fc',
    borderRadius: '3px',
    padding: '0 2px',
  },
};

let keyCounter = 0;
function nextKey(): string {
  return `md-${keyCounter++}`;
}

/**
 * Parse inline markdown (bold, italic, strikethrough, code, links, mentions)
 * into React elements.
 */
function parseInline(text: string, currentUser: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Regex for inline elements — order matters (code first to avoid processing its contents)
  // Matches: `code`, **bold**, *italic*, ~~strike~~, [text](url), @mention
  const inlineRegex = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\~\~[^~]+\~\~)|(\[[^\]]+\]\([^)]+\))|(@\w[\w-]*)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineRegex.exec(text)) !== null) {
    // Add plain text before this match
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const [full] = match;

    if (match[1]) {
      // Inline code: `code`
      const code = full.slice(1, -1);
      nodes.push(<code key={nextKey()} style={mdStyles.inlineCode}>{code}</code>);
    } else if (match[2]) {
      // Bold: **text**
      const inner = full.slice(2, -2);
      nodes.push(<strong key={nextKey()} style={mdStyles.bold}>{parseInline(inner, currentUser)}</strong>);
    } else if (match[3]) {
      // Italic: *text*
      const inner = full.slice(1, -1);
      nodes.push(<em key={nextKey()} style={mdStyles.italic}>{parseInline(inner, currentUser)}</em>);
    } else if (match[4]) {
      // Strikethrough: ~~text~~
      const inner = full.slice(2, -2);
      nodes.push(<span key={nextKey()} style={mdStyles.strike}>{parseInline(inner, currentUser)}</span>);
    } else if (match[5]) {
      // Link: [text](url)
      const linkMatch = full.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) {
        nodes.push(
          <a key={nextKey()} href={linkMatch[2]} target="_blank" rel="noopener noreferrer" style={mdStyles.link}>
            {linkMatch[1]}
          </a>
        );
      }
    } else if (match[6]) {
      // @mention
      const username = full.slice(1);
      const isSelf = username === currentUser;
      nodes.push(
        <span key={nextKey()} style={isSelf ? mdStyles.mentionSelf : mdStyles.mentionOther}>
          {full}
        </span>
      );
    }

    lastIndex = match.index + full.length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

/**
 * Render markdown text as React elements. Handles block-level elements
 * (code blocks, blockquotes, lists) and inline formatting.
 */
export function renderMarkdown(text: string, currentUser: string): React.ReactNode {
  // Reset key counter for each render call
  keyCounter = 0;

  if (!text) return null;

  // Step 1: Extract code blocks (```...```) and replace with placeholders
  const codeBlocks: { lang: string; code: string }[] = [];
  const withPlaceholders = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    codeBlocks.push({ lang, code: code.replace(/\n$/, '') });
    return `\x00CODEBLOCK_${codeBlocks.length - 1}\x00`;
  });

  // Step 2: Split into lines and process block-level elements
  const lines = withPlaceholders.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block placeholder
    const codeBlockMatch = line.match(/^\x00CODEBLOCK_(\d+)\x00$/);
    if (codeBlockMatch) {
      const block = codeBlocks[parseInt(codeBlockMatch[1])];
      elements.push(
        <pre key={nextKey()} style={mdStyles.codeBlock}>{block.code}</pre>
      );
      i++;
      continue;
    }

    // Blockquote: > text
    if (line.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <div key={nextKey()} style={mdStyles.blockquote}>
          {quoteLines.map((ql, qi) => (
            <React.Fragment key={qi}>
              {qi > 0 && <br />}
              {parseInline(ql, currentUser)}
            </React.Fragment>
          ))}
        </div>
      );
      continue;
    }

    // Unordered list: - item or * item
    if (/^[-*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <ul key={nextKey()} style={mdStyles.list}>
          {items.map((item, ii) => (
            <li key={ii}>{parseInline(item, currentUser)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list: 1. item
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\. /, ''));
        i++;
      }
      elements.push(
        <ol key={nextKey()} style={mdStyles.list}>
          {items.map((item, ii) => (
            <li key={ii}>{parseInline(item, currentUser)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Regular line — render inline markdown
    if (line.trim() === '') {
      elements.push(<br key={nextKey()} />);
    } else {
      elements.push(
        <span key={nextKey()}>
          {parseInline(line, currentUser)}
        </span>
      );
      // Add line break between consecutive non-block lines
      if (i < lines.length - 1) {
        const nextLine = lines[i + 1];
        const isNextBlock = nextLine.startsWith('> ') || /^[-*] /.test(nextLine) ||
          /^\d+\. /.test(nextLine) || /^\x00CODEBLOCK_/.test(nextLine) || nextLine.trim() === '';
        if (!isNextBlock) {
          elements.push(<br key={nextKey()} />);
        }
      }
    }
    i++;
  }

  // If the entire text is a single line with no block elements,
  // return the inline-only result for compact rendering
  if (elements.length === 1 && !text.includes('\n')) {
    return <>{parseInline(text, currentUser)}</>;
  }

  return <>{elements}</>;
}
