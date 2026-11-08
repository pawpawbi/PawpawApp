// The small amount of formatting the chat shows in the assistant's replies: fenced code blocks,
// inline `code` and **bold**. Everything else is plain text. The result is rendered as Vue
// elements with text interpolation, never as HTML, so replies can't inject markup.

export type Inline = { kind: 'text' | 'code' | 'bold'; text: string };
export type Block =
  | { kind: 'text'; parts: Inline[] }
  | { kind: 'code'; language: string; text: string };

/** Splits a line of text into plain, `code` and **bold** parts. */
export function inline(text: string): Inline[] {
  const parts: Inline[] = [];
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  for (let match; (match = pattern.exec(text)); ) {
    if (match.index > last)
      parts.push({ kind: 'text', text: text.slice(last, match.index) });
    parts.push(
      match[1] !== undefined
        ? { kind: 'code', text: match[1] }
        : { kind: 'bold', text: match[2] },
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

/** Splits a reply into text and fenced code blocks. An unclosed fence (still streaming) counts. */
export function blocks(text: string): Block[] {
  const result: Block[] = [];
  const lines = text.split('\n');
  let prose: string[] = [];
  const flushProse = () => {
    const joined = prose.join('\n').replace(/^\n+|\n+$/g, '');
    if (joined) result.push({ kind: 'text', parts: inline(joined) });
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(lines[i]);
    if (!fence) {
      prose.push(lines[i]);
      continue;
    }
    flushProse();
    const code: string[] = [];
    for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++)
      code.push(lines[i]);
    result.push({ kind: 'code', language: fence[1], text: code.join('\n') });
  }
  flushProse();
  return result;
}
