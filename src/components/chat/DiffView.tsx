import { diffLines } from 'diff';

interface DiffViewProps {
  oldText: string;
  newText: string;
}

/**
 * Minimal unified-diff view for `edit_file` tool calls. Uses `diff.diffLines`
 * to compute line-level changes and renders them inline with red `-` /
 * green `+` gutters and background tints. Context lines (unchanged) are
 * collapsed to a single "… N unchanged lines" row when the run is longer
 * than 2 lines, so long edits stay scannable.
 */
export function DiffView({ oldText, newText }: DiffViewProps) {
  const parts = diffLines(oldText, newText);
  const rows: Array<
    | { type: 'added'; lines: string[] }
    | { type: 'removed'; lines: string[] }
    | { type: 'context'; lines: string[] }
  > = [];

  for (const part of parts) {
    const lines = part.value.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0) continue;
    if (part.added) rows.push({ type: 'added', lines });
    else if (part.removed) rows.push({ type: 'removed', lines });
    else rows.push({ type: 'context', lines });
  }

  return (
    <div
      className="rounded-md overflow-hidden text-[11px] font-mono"
      style={{ boxShadow: '0 0 0 1px var(--border)' }}
    >
      {rows.map((row, i) =>
        row.type === 'context' ? (
          <ContextRows key={i} lines={row.lines} />
        ) : (
          <ChangedRows key={i} type={row.type} lines={row.lines} />
        ),
      )}
    </div>
  );
}

function ChangedRows({
  type,
  lines,
}: {
  type: 'added' | 'removed';
  lines: string[];
}) {
  const gutter = type === 'added' ? '+' : '-';
  return (
    <>
      {lines.map((line, i) => (
        <div
          key={i}
          className="flex items-start gap-2 px-2 py-0.5 whitespace-pre-wrap break-all"
          style={{
            background:
              type === 'added'
                ? 'color-mix(in oklab, oklch(65% 0.15 150) 16%, transparent)'
                : 'color-mix(in oklab, var(--destructive) 14%, transparent)',
          }}
        >
          <span
            className="select-none shrink-0 w-4 text-center"
            style={{
              color:
                type === 'added'
                  ? 'oklch(55% 0.15 150)'
                  : 'var(--destructive)',
            }}
          >
            {gutter}
          </span>
          <span className="flex-1">{line || ' '}</span>
        </div>
      ))}
    </>
  );
}

function ContextRows({ lines }: { lines: string[] }) {
  // Collapse long unchanged stretches. Keep up to 2 lines of context (1 head +
  // 1 tail) so the change has some anchor. Larger runs become a single
  // placeholder.
  if (lines.length <= 2) {
    return (
      <>
        {lines.map((line, i) => (
          <ContextLine key={i} text={line} />
        ))}
      </>
    );
  }
  return (
    <>
      <ContextLine text={lines[0]} />
      <div
        className="px-2 py-0.5 text-[10px] text-muted-foreground text-center select-none"
        style={{
          background: 'color-mix(in oklab, var(--muted) 35%, transparent)',
        }}
      >
        … {lines.length - 2} unchanged lines
      </div>
      <ContextLine text={lines[lines.length - 1]} />
    </>
  );
}

function ContextLine({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 px-2 py-0.5 whitespace-pre-wrap break-all text-muted-foreground">
      <span className="select-none shrink-0 w-4 text-center"> </span>
      <span className="flex-1">{text || ' '}</span>
    </div>
  );
}
