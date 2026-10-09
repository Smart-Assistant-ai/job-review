/**
 * Renders plain text written by an administrator: blank lines separate
 * paragraphs and lines starting with "-", "*" or "•" become bullet points.
 * Content is rendered as text, never as HTML.
 */
export function RichText({ text }: { text: string }) {
  const blocks: ({ kind: 'p'; lines: string[] } | { kind: 'ul'; items: string[] })[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    const last = blocks[blocks.length - 1];
    if (!line) {
      if (last?.kind === 'p' && last.lines.length > 0) blocks.push({ kind: 'p', lines: [] });
    } else if (bullet) {
      if (last?.kind === 'ul') last.items.push(bullet[1]);
      else blocks.push({ kind: 'ul', items: [bullet[1]] });
    } else if (last?.kind === 'p') {
      last.lines.push(line);
    } else {
      blocks.push({ kind: 'p', lines: [line] });
    }
  }

  return (
    <div className="space-y-3 text-sm leading-relaxed text-slate-700">
      {blocks.map((block, i) =>
        block.kind === 'ul' ? (
          <ul key={i} className="list-disc space-y-1 pl-5">
            {block.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ul>
        ) : block.lines.length > 0 ? (
          <p key={i} className="whitespace-pre-line">
            {block.lines.join('\n')}
          </p>
        ) : null,
      )}
    </div>
  );
}
