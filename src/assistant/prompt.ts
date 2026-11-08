// What the assistant is told: fixed instructions (cached by providers that support it), guides
// it reads when it needs them, and a short snapshot of the project sent with every request.
// The instructions and guides are docs/guides/, bundled into the app. Design: PawpawServer
// docs/app/assistant.md
import instructions from '../../docs/guides/instructions.md?raw';
import dataGuide from '../../docs/guides/data.md?raw';
import modelGuide from '../../docs/guides/model.md?raw';
import reportGuide from '../../docs/guides/report.md?raw';

/** A bundled file's text, the same whatever line endings it was checked out with. */
const text = (file: string) => file.replace(/\r\n/g, '\n').trim();

export const SYSTEM_PROMPT = text(instructions);

export const GUIDES: Record<string, { about: string; text: string }> = {
  data: {
    about:
      'adding, loading and changing data sources, and notes on setting up each connector',
    text: text(dataGuide),
  },
  model: {
    about:
      'in-place transforms, transformed tables, when they rebuild, and DuckDB SQL',
    text: text(modelGuide),
  },
  report: {
    about: 'writing report pages and datasets, the chart library, hosting',
    text: text(reportGuide),
  },
};

export interface ProjectSnapshot {
  name: string;
  step: string;
  sources: {
    name: string;
    type: string;
    tables: string[];
    lastLoadedAt: string | null;
  }[];
  tables: { name: string; kind: string; rows: number }[];
  report: {
    pages: string[];
    datasets: { name: string; error?: string }[];
  } | null;
}

/** The snapshot of the project included with each request, so simple questions need no tools. */
export function projectContext(s: ProjectSnapshot): string {
  const lines = [
    `The open project is "${s.name}". The user is on the ${s.step} step.`,
    s.sources.length
      ? `Data sources: ${s.sources
          .map(
            (x) =>
              `${x.name} (${x.type}; ${x.lastLoadedAt ? `last loaded ${x.lastLoadedAt}` : 'not loaded yet'})`,
          )
          .join('; ')}.`
      : 'There are no data sources yet.',
    s.tables.length
      ? `Tables: ${s.tables
          .slice(0, 60)
          .map((t) => `${t.name} (${t.kind}, ${t.rows} rows)`)
          .join(
            '; ',
          )}${s.tables.length > 60 ? `; and ${s.tables.length - 60} more` : ''}.`
      : 'There are no tables yet.',
    s.report
      ? `Report pages: ${s.report.pages.join('; ') || 'none'}. Datasets: ${
          s.report.datasets
            .map((d) => (d.error ? `${d.name} (failed: ${d.error})` : d.name))
            .join('; ') || 'none'
        }.`
      : 'The project has no report yet (Build visuals offers to add one).',
  ];
  return lines.join('\n');
}
