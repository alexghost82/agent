"use client";

import React from "react";

// Tiny, dependency-free Markdown renderer.
// Renders through React elements only (no dangerouslySetInnerHTML) so user/LLM
// content can never inject HTML. Supports the subset LLM answers/plans use:
// headings, bold/italic, inline code, fenced code, lists (ordered/unordered),
// blockquotes, horizontal rules, links and paragraphs.

type Token =
  | { type: "code"; lang?: string; content: string }
  | { type: "heading"; level: number; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "quote"; lines: string[] }
  | { type: "hr" }
  | { type: "p"; text: string };

function tokenize(src: string): Token[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const tokens: Token[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const lang = fence[1].trim() || undefined;
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      tokens.push({ type: "code", lang, content: buf.join("\n") });
      continue;
    }

    // Blank line
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      tokens.push({ type: "hr" });
      i++;
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      tokens.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      i++;
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      tokens.push({ type: "quote", lines: buf });
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      tokens.push({ type: "ul", items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      tokens.push({ type: "ol", items });
      continue;
    }

    // Paragraph (consume consecutive non-blank, non-structural lines)
    const buf: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    tokens.push({ type: "p", text: buf.join("\n") });
  }

  return tokens;
}

// Inline parsing: code spans, bold, italic, links. Returns React nodes.
function inline(text: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Split on inline code first so its contents aren't further parsed.
  const parts = text.split(/(`[^`]+`)/g);
  parts.forEach((part, pi) => {
    if (!part) return;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      nodes.push(<code key={`${keyBase}-c${pi}`}>{part.slice(1, -1)}</code>);
      return;
    }
    nodes.push(...inlineEmphasis(part, `${keyBase}-${pi}`));
  });
  return nodes;
}

function inlineEmphasis(text: string, keyBase: string): React.ReactNode[] {
  // Tokens: **bold**, *italic* / _italic_, [label](url)
  const rx = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|\[([^\]]+)\]\(([^)\s]+)\))/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = rx.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}-e${k++}`;
    if (m[2] !== undefined || m[3] !== undefined) {
      out.push(<strong key={key}>{m[2] ?? m[3]}</strong>);
    } else if (m[4] !== undefined || m[5] !== undefined) {
      out.push(<em key={key}>{m[4] ?? m[5]}</em>);
    } else if (m[6] !== undefined && m[7] !== undefined) {
      const href = m[7];
      const safe = /^(https?:|mailto:|\/)/i.test(href) ? href : "#";
      out.push(
        <a key={key} href={safe} target="_blank" rel="noreferrer noopener">
          {m[6]}
        </a>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ children, className }: { children: string; className?: string }) {
  const tokens = tokenize(children || "");
  return (
    <div className={`md${className ? ` ${className}` : ""}`}>
      {tokens.map((tok, idx) => {
        const key = `t${idx}`;
        switch (tok.type) {
          case "code":
            return (
              <pre key={key} className="md-code" data-lang={tok.lang || ""}>
                <code>{tok.content}</code>
              </pre>
            );
          case "heading": {
            const Tag = `h${Math.min(tok.level + 2, 6)}` as keyof React.JSX.IntrinsicElements;
            return <Tag key={key}>{inline(tok.text, key)}</Tag>;
          }
          case "ul":
            return (
              <ul key={key}>
                {tok.items.map((it, j) => (
                  <li key={`${key}-${j}`}>{inline(it, `${key}-${j}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key}>
                {tok.items.map((it, j) => (
                  <li key={`${key}-${j}`}>{inline(it, `${key}-${j}`)}</li>
                ))}
              </ol>
            );
          case "quote":
            return (
              <blockquote key={key}>
                {tok.lines.map((ln, j) => (
                  <p key={`${key}-${j}`}>{inline(ln, `${key}-${j}`)}</p>
                ))}
              </blockquote>
            );
          case "hr":
            return <hr key={key} />;
          case "p":
          default:
            return <p key={key}>{inline((tok as { text: string }).text, key)}</p>;
        }
      })}
    </div>
  );
}
