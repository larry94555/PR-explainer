// Turns the model's markdown into DOM nodes without ever parsing HTML.
//
// Model output is untrusted: a diff can contain text that tricks the model
// into replying with `<img onerror=...>` or `<script>`. Everything here is
// built with createElement and textContent, so any HTML in the reply shows up
// as plain text and never runs. Only a small subset of markdown is supported,
// which is all the explain prompt asks for:
// - paragraphs (separated by blank lines) and line breaks inside them;
// - bullet lists (-, *, +) and numbered lists (1. or 1));
// - fenced code blocks (```);
// - headings inside a section (shown in bold);
// - inline `code`, **bold**, and *italic*;
// - [links](url), shown as their text only, so a reply cannot link anywhere.

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

// Order matters: code first, so ** inside `code` stays literal. A link's URL
// may hold one level of parentheses, as in javascript:alert(1).
const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|\*(?![\s*])(.+?)\*|\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g;

/** Appends text with inline markdown (code, bold, italic, links) to `parent`. */
export function appendInline(parent: Node, text: string): void {
  const doc = parent.ownerDocument ?? (parent as Document);
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) parent.appendChild(doc.createTextNode(text.slice(last, match.index)));
    const [, code, bold, italic, linkText] = match;
    if (code !== undefined) {
      const el = doc.createElement('code');
      el.textContent = code;
      parent.appendChild(el);
    } else if (bold !== undefined) {
      const el = doc.createElement('strong');
      appendInline(el, bold);
      parent.appendChild(el);
    } else if (italic !== undefined) {
      const el = doc.createElement('em');
      appendInline(el, italic);
      parent.appendChild(el);
    } else if (linkText !== undefined) {
      appendInline(parent, linkText);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) parent.appendChild(doc.createTextNode(text.slice(last)));
}

function appendLines(parent: Node, lines: string[]): void {
  const doc = parent.ownerDocument!;
  lines.forEach((line, i) => {
    if (i > 0) parent.appendChild(doc.createElement('br'));
    appendInline(parent, line.trim());
  });
}

/** Renders `markdown` into a fragment of safe DOM nodes. */
export function renderMarkdown(doc: Document, markdown: string): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: { el: HTMLElement; ordered: boolean; item: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const p = doc.createElement('p');
    appendLines(p, paragraph);
    fragment.appendChild(p);
    paragraph = [];
  };
  const flushItem = () => {
    if (!list || list.item.length === 0) return;
    const li = doc.createElement('li');
    appendLines(li, list.item);
    list.el.appendChild(li);
    list.item = [];
  };
  const flushList = () => {
    flushItem();
    if (list) fragment.appendChild(list.el);
    list = null;
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!); i++) {
        code.push(lines[i]!);
      }
      const pre = doc.createElement('pre');
      const el = doc.createElement('code');
      el.textContent = code.join('\n');
      pre.appendChild(el);
      fragment.appendChild(pre);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const p = doc.createElement('p');
      const strong = doc.createElement('strong');
      appendInline(strong, heading[1]!.trim());
      p.appendChild(strong);
      fragment.appendChild(p);
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const itemText = bullet?.[1] ?? numbered?.[1];
    if (itemText !== undefined) {
      flushParagraph();
      const ordered = numbered !== null;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { el: doc.createElement(ordered ? 'ol' : 'ul'), ordered, item: [] };
      }
      flushItem();
      list.item.push(itemText);
      continue;
    }
    // A plain line continues the current list item, or the paragraph.
    if (list) list.item.push(line);
    else paragraph.push(line);
  }
  flush();
  return fragment;
}
