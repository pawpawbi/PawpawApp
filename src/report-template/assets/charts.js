// PawpawBI report charts: bar and line charts, headline numbers and tables, drawn as SVG and
// HTML. Part of the report site, so it works anywhere the site is hosted (no dependencies, no
// build step). Reference: the "Writing the report" guide in the PawpawBI docs
// (docs/guides/report.md).
//
// Data comes from the site's datasets, data/<name>.json, written by PawpawBI. Every name and
// value is inserted with textContent, never as HTML.
(function () {
  'use strict';

  // Categorical colours, in this order (validated for colour-blind readers in this order).
  const PALETTE = [
    '#2a78d6',
    '#eb6834',
    '#1baf7a',
    '#eda100',
    '#e87ba4',
    '#008300',
    '#6250d6',
    '#e34948',
  ];
  const MAX_SERIES = PALETTE.length;
  const MAX_BARS = 50;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HOUR = 36e5;
  const DAY = 24 * HOUR;

  // -------------------------------------------------------------------------------------------
  // Data: datasets in data/<name>.json

  // The site's root folder: this script lives in <root>/assets/.
  const script = document.currentScript;
  const ROOT = new URL(
    '../',
    script && script.src ? script.src : document.baseURI,
  );
  const loaded = new Map();

  /** Loads a dataset by name. Resolves to an array of row objects. */
  function load(name) {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
      return Promise.reject(new Error(`"${name}" isn't a dataset name.`));
    }
    if (!loaded.has(name)) {
      const request = fetch(new URL(`data/${name}.json`, ROOT), {
        cache: 'no-cache',
      })
        .then(
          (response) => {
            if (response.status === 404) {
              throw new Error(`There's no dataset called "${name}" yet.`);
            }
            if (!response.ok)
              throw new Error(`Couldn't load the dataset "${name}".`);
            return response.json();
          },
          () => {
            throw new Error(
              `Couldn't load the dataset "${name}". If you opened the page as a file, view it through a web server instead.`,
            );
          },
        )
        .then((doc) =>
          toRows(doc.columns, doc.rows, doc.truncated, doc.generatedAt),
        );
      request.catch(() => loaded.delete(name));
      loaded.set(name, request);
    }
    return loaded.get(name);
  }

  /** Rows as objects, with the column list and whether rows were left out attached. */
  function toRows(columns, rows, truncated, generatedAt) {
    const names = (columns || []).map((c) => String(c.name));
    const result = (rows || []).map((row) => {
      const object = {};
      names.forEach((name, i) => (object[name] = row[i]));
      return object;
    });
    Object.defineProperty(result, 'columns', { value: names });
    Object.defineProperty(result, 'truncated', { value: Boolean(truncated) });
    Object.defineProperty(result, 'generatedAt', {
      value: generatedAt ?? null,
    });
    return result;
  }

  /** A dataset name, a promise of rows, or rows, as rows. */
  async function resolveData(data) {
    const value = typeof data === 'string' ? await load(data) : await data;
    if (!Array.isArray(value)) {
      throw new Error('Pass a dataset name or an array of rows.');
    }
    return value;
  }

  function columnsOf(rows) {
    return rows.columns || (rows.length ? Object.keys(rows[0]) : []);
  }

  function checkColumns(rows, names) {
    const columns = columnsOf(rows);
    if (!columns.length) return;
    for (const name of names) {
      if (!columns.includes(name)) {
        throw new Error(
          `There's no column called "${name}". The data has: ${columns.join(', ')}.`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Numbers, dates and scales

  const numberFormats = new Map();
  function numberFormat(options) {
    const key = JSON.stringify(options);
    if (!numberFormats.has(key)) {
      numberFormats.set(key, new Intl.NumberFormat(undefined, options));
    }
    return numberFormats.get(key);
  }

  /**
   * A value as text. format: 'number' (default), 'percent' (0.25 is 25%), 'currency', or a
   * function. compact: shorten large numbers (12.9K); 'auto' does so from 10,000 (headline
   * numbers and labels on the marks).
   */
  function formatValue(
    value,
    format,
    { compact = false, currency = 'USD' } = {},
  ) {
    if (value === null || value === undefined || value === '') return '–';
    if (typeof format === 'function') return String(format(value));
    if (typeof value !== 'number') return String(value);
    if (compact === 'auto') compact = Math.abs(value) >= 10000;
    const short = compact && Math.abs(value) >= 1000;
    if (format === 'percent') {
      return numberFormat({
        style: 'percent',
        maximumFractionDigits: 1,
      }).format(value);
    }
    if (format === 'currency') {
      return numberFormat({
        style: 'currency',
        currency,
        notation: short ? 'compact' : 'standard',
        // Whole amounts on axes ("$0", not "$0.00").
        minimumFractionDigits: compact ? 0 : undefined,
        maximumFractionDigits: short
          ? 1
          : compact && Number.isInteger(value)
            ? 0
            : 2,
      }).format(value);
    }
    return numberFormat(
      short
        ? { notation: 'compact', maximumFractionDigits: 1 }
        : { maximumFractionDigits: 2 },
    ).format(value);
  }

  /** Round numbers covering min..max, about `count` of them. */
  function niceTicks(min, max, count = 5) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) [min, max] = [0, 1];
    if (min === max) {
      if (min === 0) max = 1;
      else if (min > 0) min = 0;
      else max = 0;
    }
    const raw = (max - min) / Math.max(1, count);
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const n = raw / magnitude;
    const step =
      (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * magnitude;
    const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
    const lo = Math.floor(min / step + 1e-9) * step;
    const hi = Math.ceil(max / step - 1e-9) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step)
      ticks.push(Number(v.toFixed(decimals)));
    return { min: ticks[0], max: ticks[ticks.length - 1], ticks };
  }

  function linear([d0, d1], [r0, r1]) {
    const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
    return (v) => r0 + (v - d0) * k;
  }

  const DATE_PATTERN =
    /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

  /** Milliseconds for an ISO date or timestamp (as the data arrives), or NaN. */
  function parseTime(value) {
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return NaN;
    let iso = value.replace(' ', 'T');
    if (iso.length === 10) iso += 'T00:00:00';
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) iso += 'Z';
    return Date.parse(iso);
  }

  // Dates arrive without a time zone, so they're shown as they are, i.e. in UTC.
  const dateFormats = new Map();
  function dateFormat(options) {
    const key = JSON.stringify(options);
    if (!dateFormats.has(key)) {
      dateFormats.set(
        key,
        new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...options }),
      );
    }
    return dateFormats.get(key);
  }

  /** Tick positions for a time axis, at round dates, at most about `maxTicks` of them. */
  function timeTicks(min, max, maxTicks) {
    const span = Math.max(max - min, 1);
    const steps = [
      [HOUR, 1, 'hour'],
      [3 * HOUR, 3, 'hour'],
      [6 * HOUR, 6, 'hour'],
      [12 * HOUR, 12, 'hour'],
      [DAY, 1, 'day'],
      [2 * DAY, 2, 'day'],
      [7 * DAY, 7, 'day'],
      [30 * DAY, 1, 'month'],
      [61 * DAY, 2, 'month'],
      [91 * DAY, 3, 'month'],
      [182 * DAY, 6, 'month'],
      [365 * DAY, 1, 'year'],
      [730 * DAY, 2, 'year'],
      [1826 * DAY, 5, 'year'],
      [3652 * DAY, 10, 'year'],
      [18262 * DAY, 50, 'year'],
    ];
    const [size, k, unit] =
      steps.find(([size]) => span / size <= maxTicks) ||
      steps[steps.length - 1];
    const ticks = [];
    if (unit === 'hour' || unit === 'day') {
      for (let t = Math.ceil(min / size) * size; t <= max; t += size)
        ticks.push(t);
    } else {
      const start = new Date(min);
      let year = start.getUTCFullYear();
      let month = unit === 'year' ? 0 : start.getUTCMonth();
      if (unit === 'year') {
        if (Date.UTC(year, 0, 1) < min) year++;
        year = Math.ceil(year / k) * k;
      } else {
        if (Date.UTC(year, month, 1) < min) month++;
        month = Math.ceil(month / k) * k;
      }
      for (;;) {
        const t = Date.UTC(year, month, 1);
        if (t > max) break;
        ticks.push(t);
        if (unit === 'year') year += k;
        else month += k;
      }
    }
    return { ticks, unit };
  }

  function timeTickLabel(t, unit) {
    if (unit === 'hour')
      return dateFormat({ hour: '2-digit', minute: '2-digit' }).format(t);
    if (unit === 'day')
      return dateFormat({ day: 'numeric', month: 'short' }).format(t);
    if (unit === 'month')
      return dateFormat({ month: 'short', year: 'numeric' }).format(t);
    return dateFormat({ year: 'numeric' }).format(t);
  }

  function timeLabel(t, withTime) {
    return dateFormat(
      withTime
        ? { dateStyle: 'medium', timeStyle: 'short' }
        : { dateStyle: 'medium' },
    ).format(t);
  }

  // -------------------------------------------------------------------------------------------
  // Series: rows -> { keys, labels, series: [{ name, colour, values: Map(key -> number) }] }

  /**
   * One series for `y`, one per column if `y` is a list, or one per value of the `series`
   * column. More than eight are folded: the seven largest stay and the rest add up to "Other".
   */
  function buildSeries(rows, options) {
    const columns = columnsOf(rows);
    const x = options.x ?? columns[0];
    const ys = Array.isArray(options.y) ? options.y : [options.y ?? columns[1]];
    checkColumns(rows, [x, ...ys, ...(options.series ? [options.series] : [])]);

    const keys = [];
    const labels = new Map();
    const byName = new Map();
    const add = (name, key, value) => {
      if (!byName.has(name)) byName.set(name, new Map());
      const values = byName.get(name);
      const number =
        typeof value === 'number' && Number.isFinite(value) ? value : null;
      values.set(
        key,
        number === null
          ? (values.get(key) ?? null)
          : (values.get(key) ?? 0) + number,
      );
    };
    for (const row of rows) {
      const key = String(row[x]);
      if (!labels.has(key)) {
        labels.set(key, row[x]);
        keys.push(key);
      }
      if (options.series) {
        const name =
          row[options.series] == null ? '(blank)' : String(row[options.series]);
        add(name, key, row[ys[0]]);
      } else {
        for (const y of ys) add(options.labels?.[y] ?? y, key, row[y]);
      }
    }

    let series = [...byName].map(([name, values]) => ({ name, values }));
    let folded = 0;
    if (series.length > MAX_SERIES) {
      const total = (s) =>
        [...s.values.values()].reduce((a, v) => a + Math.abs(v ?? 0), 0);
      const keep = new Set(
        [...series]
          .sort((a, b) => total(b) - total(a))
          .slice(0, MAX_SERIES - 1),
      );
      const rest = series.filter((s) => !keep.has(s));
      folded = rest.length;
      const other = new Map();
      for (const key of keys) {
        const values = rest
          .map((s) => s.values.get(key))
          .filter((v) => v != null);
        other.set(
          key,
          values.length ? values.reduce((a, v) => a + v, 0) : null,
        );
      }
      series = series
        .filter((s) => keep.has(s))
        .concat([{ name: 'Other', values: other }]);
    }
    series.forEach((s, i) => (s.colour = PALETTE[i]));
    return { x, keys, labels, series, folded };
  }

  // -------------------------------------------------------------------------------------------
  // DOM helpers

  function el(tag, className, parent, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }

  function svgEl(tag, attributes, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes || {})) {
      if (value !== null && value !== undefined)
        node.setAttribute(name, String(value));
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  function targetOf(target) {
    const node =
      typeof target === 'string' ? document.querySelector(target) : target;
    if (!(node instanceof Element)) {
      throw new Error(
        `No element on the page matches ${JSON.stringify(String(target))}.`,
      );
    }
    return node;
  }

  let measureContext;
  function textWidth(text, size = 12, weight = 400) {
    measureContext ??= document.createElement('canvas').getContext('2d');
    measureContext.font = `${weight} ${size}px ${getComputedStyle(document.body).fontFamily}`;
    return measureContext.measureText(text).width;
  }

  function truncate(text, maxWidth, size = 12) {
    if (textWidth(text, size) <= maxWidth) return text;
    let cut = text;
    while (cut.length > 1 && textWidth(cut + '…', size) > maxWidth)
      cut = cut.slice(0, -1);
    return cut + '…';
  }

  /**
   * Runs a visual: shows "Loading…", then its content or what went wrong. Resolves either way,
   * so one broken visual doesn't stop the rest of the page.
   */
  async function render(target, data, draw) {
    let node;
    try {
      node = targetOf(target);
    } catch (error) {
      showPageError(error);
      return;
    }
    node.classList.add('pp-visual');
    node.replaceChildren(el('div', 'pp-loading', null, 'Loading…'));
    try {
      const rows = await resolveData(data);
      node.replaceChildren();
      draw(node, rows);
    } catch (error) {
      node.replaceChildren();
      const box = el('div', 'pp-error', node);
      el('strong', null, box, "This visual couldn't be shown. ");
      el(
        'span',
        null,
        box,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** The title, legend, plot area, table view and notes every chart shares. */
  function chartFrame(node, options, legend) {
    const head = el('div', 'pp-head', node);
    if (options.title) el('h3', 'pp-title', head, options.title);
    if (options.subtitle) el('p', 'pp-subtitle', head, options.subtitle);
    const toggle = el('button', 'pp-toggle', node, 'Show table');
    toggle.type = 'button';
    if (legend.series.length > 1) {
      const box = el('div', 'pp-legend', node);
      for (const s of legend.series) {
        const item = el('span', 'pp-legend-item', box);
        const key = el('span', `pp-key pp-key-${legend.mark}`, item);
        key.style.background = s.colour;
        el('span', null, item, s.name);
      }
    }
    const plot = el('div', 'pp-plot', node);
    const table = el('div', 'pp-table-view', node);
    table.hidden = true;
    const notes = el('div', 'pp-notes', node);
    toggle.addEventListener('click', () => {
      table.hidden = !table.hidden;
      plot.hidden = !table.hidden;
      toggle.textContent = table.hidden ? 'Show table' : 'Show chart';
    });
    return { plot, table, notes };
  }

  function noData(node, options) {
    const head = el('div', 'pp-head', node);
    if (options.title) el('h3', 'pp-title', head, options.title);
    el('p', 'pp-note', node, "There's no data to show.");
  }

  function note(notes, text) {
    el('p', 'pp-note', notes, text);
  }

  /** Notes under a chart: series folded into "Other", and rows the dataset left out. */
  function seriesNotes(frame, built, rows) {
    if (built.folded) {
      note(
        frame.notes,
        `${built.folded} smaller series are added together as "Other".`,
      );
    }
    if (rows.truncated) {
      note(
        frame.notes,
        "Only the first rows of the data are shown. Group or limit the data in the dataset's query.",
      );
    }
  }

  /** Draws into `plot` now and again whenever its width changes. */
  function responsive(plot, draw) {
    let width = 0;
    const redraw = () => {
      const next = Math.floor(plot.clientWidth);
      if (!next || next === width) return;
      width = next;
      plot.replaceChildren();
      draw(width);
    };
    redraw();
    new ResizeObserver(() => requestAnimationFrame(redraw)).observe(plot);
  }

  /** Tooltip rows for `series` at `key`: value first, named when there's more than one series. */
  function tipRows(series, key, format, currency) {
    return series.map((s) => ({
      colour: s.colour,
      value: formatValue(s.values.get(key), format, { currency }),
      name: series.length > 1 ? s.name : '',
    }));
  }

  /** A tooltip in `plot`: a heading, then one row per series, value first. */
  function tooltip(plot) {
    const tip = el('div', 'pp-tooltip', plot);
    tip.setAttribute('role', 'status');
    tip.hidden = true;
    return {
      show(heading, rows, x, y) {
        tip.replaceChildren();
        el('div', 'pp-tip-heading', tip, heading);
        for (const row of rows) {
          const line = el('div', 'pp-tip-row', tip);
          const key = el('span', 'pp-key pp-key-line', line);
          key.style.background = row.colour;
          el('strong', null, line, row.value);
          if (row.name) el('span', 'pp-tip-name', line, row.name);
        }
        tip.hidden = false;
        const width = tip.offsetWidth;
        const height = tip.offsetHeight;
        const left =
          x + 14 + width > plot.clientWidth ? x - 14 - width : x + 14;
        tip.style.left = `${Math.max(0, left)}px`;
        tip.style.top = `${Math.min(Math.max(0, y - height / 2), plot.clientHeight - height)}px`;
      },
      hide() {
        tip.hidden = true;
      },
    };
  }

  /**
   * Hover and keyboard for charts read by position: the nearest position to the pointer (or
   * the one chosen with the arrow keys) is passed to `onIndex`, and null when it leaves.
   */
  function positionHover(svg, area, positions, axis, onIndex) {
    const hit = svgEl(
      'rect',
      { ...area, fill: 'transparent', class: 'pp-hit' },
      svg,
    );
    let current = null;
    const set = (index) => {
      if (index === current) return;
      current = index;
      onIndex(index);
    };
    const nearest = (value) => {
      let best = 0;
      for (let i = 1; i < positions.length; i++) {
        if (Math.abs(positions[i] - value) < Math.abs(positions[best] - value))
          best = i;
      }
      return best;
    };
    hit.addEventListener('pointermove', (event) => {
      const box = svg.getBoundingClientRect();
      set(
        nearest(
          axis === 'x' ? event.clientX - box.left : event.clientY - box.top,
        ),
      );
    });
    hit.addEventListener('pointerleave', () => set(null));
    svg.setAttribute('tabindex', '0');
    svg.addEventListener('keydown', (event) => {
      const forward = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
      const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
      if (event.key !== forward && event.key !== back) return;
      event.preventDefault();
      const step = event.key === forward ? 1 : -1;
      set(
        current === null
          ? 0
          : Math.min(positions.length - 1, Math.max(0, current + step)),
      );
    });
    svg.addEventListener('blur', () => set(null));
  }

  /** A table of the chart's data, for the table view. */
  function dataTable(container, headings, rows, alignRight) {
    const table = el('table', 'pp-table', container);
    const head = el('tr', null, el('thead', null, table));
    headings.forEach((h, i) =>
      el('th', alignRight[i] ? 'pp-num' : null, head, h),
    );
    const body = el('tbody', null, table);
    for (const row of rows) {
      const tr = el('tr', null, body);
      row.forEach((cell, i) =>
        el('td', alignRight[i] ? 'pp-num' : null, tr, cell),
      );
    }
  }

  function seriesTable(container, built, xLabel, format, currency) {
    dataTable(
      container,
      [built.x, ...built.series.map((s) => s.name)],
      built.keys.map((key) => [
        xLabel(key),
        ...built.series.map((s) =>
          formatValue(s.values.get(key), format, { currency }),
        ),
      ]),
      [false, ...built.series.map(() => true)],
    );
  }

  function axisText(parent, attributes, text) {
    const node = svgEl(
      'text',
      { class: 'pp-axis-label', ...attributes },
      parent,
    );
    node.textContent = text;
    return node;
  }

  /** The chart's SVG, labelled for screen readers. */
  function chartSvg(plot, width, height, label) {
    return svgEl(
      'svg',
      { width, height, class: 'pp-svg', role: 'img', 'aria-label': label },
      plot,
    );
  }

  /** The widest tick label on a value axis, to leave room for it. */
  function tickWidth(scale, format, currency) {
    return Math.max(
      ...scale.ticks.map((t) =>
        textWidth(formatValue(t, format, { compact: true, currency })),
      ),
    );
  }

  /**
   * A value axis: a gridline and label at each tick. `axis` 'y' runs the lines across (labels to
   * the left of `from`), 'x' runs them down (labels above `from`). With `zeroLine`, the tick at
   * zero is drawn as the baseline.
   */
  function valueAxis(
    svg,
    { scale, place, axis, from, to, format, currency, zeroLine = false },
  ) {
    for (const t of scale.ticks) {
      const at = place(t);
      const cls = zeroLine && t === 0 ? 'pp-baseline' : 'pp-grid';
      const text = formatValue(t, format, { compact: true, currency });
      if (axis === 'y') {
        svgEl('line', { x1: from, x2: to, y1: at, y2: at, class: cls }, svg);
        axisText(
          svg,
          {
            x: from - 8,
            y: at,
            'text-anchor': 'end',
            'dominant-baseline': 'middle',
          },
          text,
        );
      } else {
        svgEl('line', { x1: at, x2: at, y1: from, y2: to, class: cls }, svg);
        axisText(svg, { x: at, y: from - 8, 'text-anchor': 'middle' }, text);
      }
    }
  }

  /** A bar with a rounded data end and a square end at the baseline. */
  function barPath(horizontal, base, end, offset, thickness) {
    const length = Math.abs(end - base);
    const r = Math.min(4, thickness / 2, length);
    if (horizontal) {
      const d = end > base ? -1 : 1;
      const [y, h] = [offset, thickness];
      return `M${base},${y}H${end + r * d}Q${end},${y} ${end},${y + r}V${y + h - r}Q${end},${y + h} ${end + r * d},${y + h}H${base}Z`;
    }
    const d = end < base ? 1 : -1;
    const [x, w] = [offset, thickness];
    return `M${x},${base}V${end + r * d}Q${x},${end} ${x + r},${end}H${x + w - r}Q${x + w},${end} ${x + w},${end + r * d}V${base}Z`;
  }

  // -------------------------------------------------------------------------------------------
  // Bar chart

  /**
   * pawpaw.barChart(target, data, { x, y, series, labels, title, subtitle, orientation,
   * format, currency, height })
   */
  function barChart(target, data, options = {}) {
    return render(target, data, (node, rows) => {
      if (!rows.length) return noData(node, options);
      const built = buildSeries(rows, options);
      const frame = chartFrame(node, options, {
        series: built.series,
        mark: 'bar',
      });
      const total = built.keys.length;
      if (total > MAX_BARS) {
        built.keys = built.keys.slice(0, MAX_BARS);
        note(
          frame.notes,
          `Showing the first ${MAX_BARS} of ${total} bars. Group or limit the data in the query to show fewer.`,
        );
      }
      seriesNotes(frame, built, rows);
      const { format, currency } = options;
      const label = (key) => String(built.labels.get(key) ?? '(blank)');
      const longest = Math.max(0, ...built.keys.map((k) => label(k).length));
      const horizontal =
        options.orientation === 'horizontal' ||
        (options.orientation !== 'vertical' &&
          (longest > 12 || built.keys.length > 12));
      seriesTable(frame.table, built, label, format, currency);

      const n = built.series.length;
      const values = built.series.flatMap((s) =>
        built.keys.map((k) => s.values.get(k) ?? 0),
      );
      const scale = niceTicks(
        Math.min(0, ...values),
        Math.max(0, ...values),
        horizontal ? 4 : 5,
      );
      // Label each bar's value when there's one series and few enough bars.
      const tipLabels = n === 1 && built.keys.length <= 15;
      const valueText = (v) =>
        formatValue(v, format, { compact: 'auto', currency });

      responsive(frame.plot, (width) => {
        const tip = tooltip(frame.plot);
        const thickness = n === 1 ? 20 : Math.max(6, Math.min(24, 48 / n));
        const group = n * thickness + (n - 1) * 2;
        const ariaLabel = options.title || 'Bar chart';

        let svg, positions, bands, scaleValue, baseline, area;
        if (horizontal) {
          const step = group + 12;
          const labelWidth = Math.min(
            width * 0.4,
            Math.max(...built.keys.map((k) => textWidth(label(k)))) + 8,
          );
          const valueWidth = tipLabels
            ? Math.max(...values.map((v) => textWidth(valueText(v)))) + 8
            : 12;
          const top = tipLabels ? 4 : 24;
          const height = top + step * built.keys.length + 4;
          const left = labelWidth;
          const right = width - valueWidth;
          svg = chartSvg(frame.plot, width, height, ariaLabel);
          scaleValue = linear([scale.min, scale.max], [left, right]);
          baseline = scaleValue(0);
          if (!tipLabels) {
            valueAxis(svg, {
              scale,
              place: scaleValue,
              axis: 'x',
              from: top,
              to: height - 4,
              format,
              currency,
            });
          }
          bands = built.keys.map((key, i) => ({
            key,
            start: top + i * step,
            size: step,
          }));
          positions = bands.map((b) => b.start + b.size / 2);
          bands.forEach((band, i) => {
            const y = positions[i];
            axisText(
              svg,
              {
                x: left - 8,
                y,
                'text-anchor': 'end',
                'dominant-baseline': 'middle',
              },
              truncate(label(band.key), labelWidth - 8),
            );
            built.series.forEach((s, j) => {
              const v = s.values.get(band.key);
              if (!v) return;
              const offset = y - group / 2 + j * (thickness + 2);
              svgEl(
                'path',
                {
                  d: barPath(true, baseline, scaleValue(v), offset, thickness),
                  fill: s.colour,
                  class: 'pp-bar',
                },
                svg,
              );
              if (tipLabels) {
                const end = scaleValue(v);
                axisText(
                  svg,
                  {
                    x: v < 0 ? end - 6 : end + 6,
                    y,
                    'text-anchor': v < 0 ? 'end' : 'start',
                    'dominant-baseline': 'middle',
                    class: 'pp-value-label',
                  },
                  valueText(v),
                );
              }
            });
          });
          svgEl(
            'line',
            {
              x1: baseline,
              x2: baseline,
              y1: top,
              y2: height - 4,
              class: 'pp-baseline',
            },
            svg,
          );
          area = { x: 0, y: top, width, height: height - top };
        } else {
          const height = options.height ?? 280;
          // Values on the bars replace the value axis, if they fit.
          const roughStep = (width - 4) / built.keys.length;
          const showTip =
            tipLabels &&
            values.every((v) => textWidth(valueText(v)) <= roughStep - 4);
          const left = showTip ? 4 : tickWidth(scale, format, currency) + 12;
          const top = 20;
          const bottom = height - 28;
          svg = chartSvg(frame.plot, width, height, ariaLabel);
          scaleValue = linear([scale.min, scale.max], [bottom, top]);
          baseline = scaleValue(0);
          if (!showTip) {
            valueAxis(svg, {
              scale,
              place: scaleValue,
              axis: 'y',
              from: left,
              to: width,
              format,
              currency,
            });
          }
          const step = (width - left) / built.keys.length;
          bands = built.keys.map((key, i) => ({
            key,
            start: left + i * step,
            size: step,
          }));
          positions = bands.map((b) => b.start + b.size / 2);
          const groupWidth = Math.min(group, step * 0.8);
          const barWidth = (groupWidth - (n - 1) * 2) / n;
          // Category labels, skipping some if they'd overlap.
          const widest = Math.max(
            ...built.keys.map((k) => textWidth(label(k))),
          );
          const every = Math.max(1, Math.ceil((widest + 8) / step));
          bands.forEach((band, i) => {
            const x = positions[i];
            if (i % every === 0) {
              axisText(
                svg,
                { x, y: bottom + 18, 'text-anchor': 'middle' },
                truncate(label(band.key), step * every - 4),
              );
            }
            built.series.forEach((s, j) => {
              const v = s.values.get(band.key);
              if (!v) return;
              const offset = x - groupWidth / 2 + j * (barWidth + 2);
              svgEl(
                'path',
                {
                  d: barPath(false, baseline, scaleValue(v), offset, barWidth),
                  fill: s.colour,
                  class: 'pp-bar',
                },
                svg,
              );
              if (showTip) {
                const end = scaleValue(v);
                axisText(
                  svg,
                  {
                    x,
                    y: v < 0 ? end + 14 : end - 6,
                    'text-anchor': 'middle',
                    class: 'pp-value-label',
                  },
                  valueText(v),
                );
              }
            });
          });
          svgEl(
            'line',
            {
              x1: left,
              x2: width,
              y1: baseline,
              y2: baseline,
              class: 'pp-baseline',
            },
            svg,
          );
          area = { x: left, y: 0, width: width - left, height };
        }

        const highlight = svgEl(
          'rect',
          { class: 'pp-band-highlight', visibility: 'hidden' },
          svg,
        );
        svg.insertBefore(highlight, svg.firstChild);
        positionHover(svg, area, positions, horizontal ? 'y' : 'x', (i) => {
          if (i === null) {
            highlight.setAttribute('visibility', 'hidden');
            tip.hide();
            return;
          }
          const band = bands[i];
          const attrs = horizontal
            ? { x: 0, y: band.start, width, height: band.size }
            : {
                x: band.start,
                y: 0,
                width: band.size,
                height: svg.height.baseVal.value,
              };
          for (const [k, v] of Object.entries(attrs))
            highlight.setAttribute(k, v);
          highlight.setAttribute('visibility', 'visible');
          const [x, y] = horizontal
            ? [
                Math.max(
                  baseline,
                  ...built.series.map((s) =>
                    scaleValue(s.values.get(band.key) ?? 0),
                  ),
                ),
                positions[i],
              ]
            : [
                positions[i],
                scaleValue(
                  Math.max(
                    0,
                    ...built.series.map((s) => s.values.get(band.key) ?? 0),
                  ),
                ),
              ];
          tip.show(
            label(band.key),
            tipRows(built.series, band.key, format, currency),
            x,
            y,
          );
        });
      });
    });
  }

  // -------------------------------------------------------------------------------------------
  // Line chart

  /**
   * pawpaw.lineChart(target, data, { x, y, series, labels, title, subtitle, format, currency,
   * height, zero })
   */
  function lineChart(target, data, options = {}) {
    return render(target, data, (node, rows) => {
      if (!rows.length) return noData(node, options);
      const built = buildSeries(rows, options);
      const { format, currency } = options;
      const raw = built.keys.map((k) => built.labels.get(k));
      const present = raw.filter((v) => v !== null && v !== undefined);
      const xType =
        options.xType ??
        (present.length && present.every((v) => typeof v === 'number')
          ? 'number'
          : present.length && present.every((v) => !Number.isNaN(parseTime(v)))
            ? 'time'
            : 'category');
      const toNumber = (v) => (xType === 'time' ? parseTime(v) : Number(v));
      let points = built.keys.map((key, i) => ({
        key,
        value: xType === 'category' ? i : toNumber(built.labels.get(key)),
      }));
      if (xType !== 'category') {
        points = points
          .filter((p) => Number.isFinite(p.value))
          .sort((a, b) => a.value - b.value);
      }
      const withTime =
        xType === 'time' && points.some((p) => p.value % DAY !== 0);
      const xLabel = (key) => {
        const v = built.labels.get(key);
        if (xType === 'time') return timeLabel(parseTime(v), withTime);
        if (xType === 'number') return formatValue(v);
        return String(v ?? '(blank)');
      };

      const frame = chartFrame(node, options, {
        series: built.series,
        mark: 'line',
      });
      seriesTable(
        frame.table,
        { ...built, keys: points.map((p) => p.key) },
        xLabel,
        format,
        currency,
      );
      seriesNotes(frame, built, rows);

      const values = built.series
        .flatMap((s) => points.map((p) => s.values.get(p.key)))
        .filter((v) => v != null);
      let lo = Math.min(...values);
      let hi = Math.max(...values);
      const zero = options.zero ?? (lo >= 0 ? lo < hi * 0.6 : hi <= 0);
      if (zero) [lo, hi] = [Math.min(0, lo), Math.max(0, hi)];
      const scale = niceTicks(lo, hi, 5);
      const n = built.series.length;

      /** A series' last value, as the label at its line's end. */
      const valueText = (s) => {
        const last = [...points]
          .reverse()
          .map((p) => s.values.get(p.key))
          .find((v) => v != null);
        return formatValue(last, format, { compact: 'auto', currency });
      };

      responsive(frame.plot, (width) => {
        const tip = tooltip(frame.plot);
        const height = options.height ?? 280;
        // Direct labels at the line ends for up to four series, unless they'd collide.
        const endLabels = n <= 4;
        const endWidth = endLabels
          ? Math.max(
              ...built.series.map((s) =>
                textWidth(n > 1 ? s.name : valueText(s)),
              ),
            ) + 16
          : 12;
        const left = tickWidth(scale, format, currency) + 12;
        const right = width - Math.min(endWidth, width * 0.3);
        const top = 12;
        const bottom = height - 28;
        const svg = chartSvg(
          frame.plot,
          width,
          height,
          options.title || 'Line chart',
        );
        const y = linear([scale.min, scale.max], [bottom, top]);
        const domain =
          xType === 'category'
            ? [0, Math.max(1, points.length - 1)]
            : [points[0]?.value ?? 0, points[points.length - 1]?.value ?? 1];
        const x = linear(
          domain[0] === domain[1] ? [domain[0] - 1, domain[1] + 1] : domain,
          [left, right],
        );

        valueAxis(svg, {
          scale,
          place: y,
          axis: 'y',
          from: left,
          to: right,
          format,
          currency,
          zeroLine: true,
        });
        const maxTicks = Math.max(2, Math.floor((right - left) / 80));
        if (xType === 'time') {
          const { ticks, unit } = timeTicks(domain[0], domain[1], maxTicks);
          for (const t of ticks)
            axisText(
              svg,
              { x: x(t), y: bottom + 18, 'text-anchor': 'middle' },
              timeTickLabel(t, unit),
            );
        } else if (xType === 'number') {
          for (const t of niceTicks(domain[0], domain[1], maxTicks).ticks) {
            if (t >= domain[0] && t <= domain[1])
              axisText(
                svg,
                { x: x(t), y: bottom + 18, 'text-anchor': 'middle' },
                formatValue(t, null, { compact: true }),
              );
          }
        } else {
          const every = Math.max(1, Math.ceil(points.length / maxTicks));
          points.forEach((p, i) => {
            if (i % every === 0)
              axisText(
                svg,
                { x: x(p.value), y: bottom + 18, 'text-anchor': 'middle' },
                truncate(xLabel(p.key), 80 * every - 8),
              );
          });
        }

        const ends = [];
        for (const s of built.series) {
          let d = '';
          let last = null;
          // Points in the current unbroken run. A run of one has no line, so it gets a dot.
          let run = [];
          const endRun = () => {
            if (run.length === 1) {
              svgEl(
                'circle',
                {
                  cx: run[0].x,
                  cy: run[0].y,
                  r: 3,
                  fill: s.colour,
                  class: 'pp-dot',
                },
                svg,
              );
            }
            run = [];
          };
          for (const p of points) {
            const v = s.values.get(p.key);
            if (v == null) {
              endRun();
              continue;
            }
            d += `${run.length ? 'L' : 'M'}${x(p.value)},${y(v)}`;
            last = { x: x(p.value), y: y(v), v };
            run.push(last);
          }
          endRun();
          svgEl('path', { d, stroke: s.colour, class: 'pp-line' }, svg);
          if (last) {
            svgEl(
              'circle',
              { cx: last.x, cy: last.y, r: 4, fill: s.colour, class: 'pp-dot' },
              svg,
            );
            ends.push({ ...last, s });
          }
        }
        ends.sort((a, b) => a.y - b.y);
        const collide = ends.some((e, i) => i > 0 && e.y - ends[i - 1].y < 14);
        if (endLabels && !collide) {
          for (const e of ends) {
            axisText(
              svg,
              {
                x: e.x + 8,
                y: e.y,
                'dominant-baseline': 'middle',
                class: 'pp-value-label',
              },
              n > 1
                ? e.s.name
                : formatValue(e.v, format, { compact: 'auto', currency }),
            );
          }
        }

        // Crosshair: a hairline at the nearest x, with a dot on each series.
        const cross = svgEl(
          'g',
          { visibility: 'hidden', class: 'pp-crosshair' },
          svg,
        );
        const hair = svgEl(
          'line',
          { y1: top, y2: bottom, class: 'pp-hair' },
          cross,
        );
        const dots = built.series.map((s) =>
          svgEl('circle', { r: 4, fill: s.colour, class: 'pp-dot' }, cross),
        );
        const positions = points.map((p) => x(p.value));
        positionHover(
          svg,
          { x: left, y: 0, width: right - left + 8, height },
          positions,
          'x',
          (i) => {
            if (i === null) {
              cross.setAttribute('visibility', 'hidden');
              tip.hide();
              return;
            }
            const p = points[i];
            hair.setAttribute('x1', positions[i]);
            hair.setAttribute('x2', positions[i]);
            built.series.forEach((s, j) => {
              const v = s.values.get(p.key);
              dots[j].setAttribute(
                'visibility',
                v == null ? 'hidden' : 'visible',
              );
              if (v != null) {
                dots[j].setAttribute('cx', positions[i]);
                dots[j].setAttribute('cy', y(v));
              }
            });
            cross.setAttribute('visibility', 'visible');
            // Largest value first.
            const value = (s) => s.values.get(p.key) ?? -Infinity;
            const shown = [...built.series].sort((a, b) => value(b) - value(a));
            tip.show(
              xLabel(p.key),
              tipRows(shown, p.key, format, currency),
              positions[i],
              (top + bottom) / 2,
            );
          },
        );
      });
    });
  }

  // -------------------------------------------------------------------------------------------
  // Stat tile and table

  /**
   * pawpaw.stat(target, data, { label, value, format, currency, delta, deltaLabel,
   * deltaFormat, upIsGood }). `value` and `delta` are column names (default: the first column).
   */
  function stat(target, data, options = {}) {
    const source = typeof data === 'number' ? [{ value: data }] : data;
    return render(target, source, (node, rows) => {
      const column =
        typeof data === 'number'
          ? 'value'
          : (options.value ?? columnsOf(rows)[0]);
      checkColumns(rows, [column, ...(options.delta ? [options.delta] : [])]);
      const value = rows[0]?.[column] ?? null;
      const tile = el('div', 'pp-stat', node);
      el('div', 'pp-stat-label', tile, options.label ?? column);
      el(
        'div',
        'pp-stat-value',
        tile,
        formatValue(value, options.format, {
          compact: 'auto',
          currency: options.currency,
        }),
      );
      if (options.delta) {
        const delta = rows[0]?.[options.delta];
        if (typeof delta === 'number') {
          const good =
            delta === 0 ? null : delta > 0 === (options.upIsGood ?? true);
          const line = el(
            'div',
            `pp-stat-delta ${good === null ? '' : good ? 'pp-good' : 'pp-bad'}`,
            tile,
          );
          el(
            'span',
            'pp-delta-icon',
            line,
            delta > 0 ? '▲' : delta < 0 ? '▼' : '■',
          ).setAttribute('aria-hidden', 'true');
          const text = formatValue(
            Math.abs(delta),
            options.deltaFormat ?? options.format,
            { currency: options.currency },
          );
          el(
            'span',
            null,
            line,
            `${delta > 0 ? 'Up' : delta < 0 ? 'Down' : 'No change'}${delta ? ' ' + text : ''}${options.deltaLabel ? ' ' + options.deltaLabel : ''}`,
          );
        }
      }
    });
  }

  /** pawpaw.table(target, data, { columns, labels, format, currency, title, maxRows }) */
  function table(target, data, options = {}) {
    return render(target, data, (node, rows) => {
      const columns = options.columns ?? columnsOf(rows);
      checkColumns(rows, columns);
      const maxRows = options.maxRows ?? 500;
      if (options.title)
        el('h3', 'pp-title', el('div', 'pp-head', node), options.title);
      const numeric = columns.map((c) =>
        rows.some((r) => typeof r[c] === 'number'),
      );
      const formatFor = (c) =>
        options.format && typeof options.format === 'object'
          ? options.format[c]
          : options.format;
      const wrap = el('div', 'pp-table-wrap', node);
      dataTable(
        wrap,
        columns.map((c) => options.labels?.[c] ?? c),
        rows
          .slice(0, maxRows)
          .map((r) =>
            columns.map((c) =>
              formatValue(r[c], formatFor(c), { currency: options.currency }),
            ),
          ),
        numeric,
      );
      if (rows.length > maxRows || rows.truncated) {
        note(
          el('div', 'pp-notes', node),
          `Showing the first ${Math.min(rows.length, maxRows).toLocaleString()} rows.`,
        );
      }
    });
  }

  // -------------------------------------------------------------------------------------------
  // Navigation

  /**
   * pawpaw.nav(target): the report's title (linking to the landing page) and links to every
   * page in report.json, in order, with the current page marked. Pages are pages/<id>.html
   * under the site's root.
   */
  async function nav(target) {
    let node;
    try {
      node = targetOf(target);
      const response = await fetch(new URL('report.json', ROOT), {
        cache: 'no-cache',
      });
      const report = await response.json();
      const home = el(
        'a',
        'pp-nav-title',
        null,
        String(report.title ?? 'Report'),
      );
      home.href = new URL('index.html', ROOT).href;
      const list = el('ul', 'pp-nav-list');
      for (const page of Array.isArray(report.pages) ? report.pages : []) {
        if (typeof page?.id !== 'string' || !/^[0-9a-f-]{36}$/.test(page.id))
          continue;
        const href = new URL(`pages/${page.id}.html`, ROOT);
        const link = el(
          'a',
          'pp-nav-link',
          el('li', null, list),
          String(page.title ?? 'Untitled page'),
        );
        link.href = href.href;
        if (href.pathname === location.pathname)
          link.setAttribute('aria-current', 'page');
      }
      node.replaceChildren(home, list);
    } catch {
      // No report.json (e.g. a page viewed on its own): leave the navigation empty.
      if (node) node.replaceChildren();
    }
  }

  // -------------------------------------------------------------------------------------------
  // Page errors and styles

  function showPageError(error) {
    if (!document.body) return;
    let box = document.querySelector('.pp-page-error');
    if (!box) {
      box = el('div', 'pp-page-error');
      document.body.prepend(box);
    }
    box.replaceChildren();
    el('strong', null, box, 'Something on this page went wrong. ');
    el(
      'span',
      null,
      box,
      error instanceof Error ? error.message : String(error ?? 'Unknown error'),
    );
  }

  window.addEventListener('error', (event) =>
    showPageError(event.error ?? event.message),
  );
  window.addEventListener('unhandledrejection', (event) =>
    showPageError(event.reason),
  );

  const style = document.createElement('style');
  // The charts' own styles. :where() keeps them at the lowest specificity, so the site's
  // stylesheet (assets/report.css) and a page's own styles always win.
  style.textContent = `
:where(:root) {
  --pp-page: #f6f5f2; --pp-surface: #ffffff; --pp-ink: #16161a; --pp-ink-2: #52514e;
  --pp-muted: #898781; --pp-grid: #ecebe6; --pp-axis: #c3c2b7; --pp-border: #e4e2dc;
  --pp-accent: #e8622a; --pp-good: #006300; --pp-bad: #d03b3b;
  --pp-font: system-ui, -apple-system, 'Segoe UI', sans-serif;
  color-scheme: light;
}
:where(.pp-visual) { position: relative; box-sizing: border-box; min-width: 0; padding: 16px 18px;
  border: 1px solid var(--pp-border); border-radius: 12px; background: var(--pp-surface); }
:where(.pp-head) { padding-right: 88px; }
:where(.pp-title) { font-size: 16px; font-weight: 800; letter-spacing: -0.01em; }
:where(.pp-subtitle) { margin: 2px 0 0; color: var(--pp-ink-2); font-size: 13px; }
:where(.pp-toggle) { position: absolute; top: 12px; right: 12px; padding: 3px 8px; border: 1px solid var(--pp-border);
  border-radius: 6px; background: var(--pp-surface); color: var(--pp-ink-2); font: 12px var(--pp-font); cursor: pointer; }
:where(.pp-toggle:hover) { background: var(--pp-page); }
:where(.pp-legend) { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; color: var(--pp-ink-2); font-size: 12px; }
:where(.pp-legend-item) { display: inline-flex; align-items: center; gap: 6px; }
:where(.pp-key) { display: inline-block; flex: none; }
:where(.pp-key-bar) { width: 10px; height: 10px; border-radius: 2px; }
:where(.pp-key-line) { width: 12px; height: 3px; border-radius: 2px; }
:where(.pp-plot) { position: relative; margin-top: 10px; }
:where(.pp-svg) { display: block; overflow: visible; outline: none; }
:where(.pp-svg:focus-visible) { outline: 2px solid var(--pp-accent); outline-offset: 2px; border-radius: 4px; }
:where(.pp-axis-label) { fill: var(--pp-muted); font: 12px var(--pp-font); font-variant-numeric: tabular-nums; }
:where(.pp-value-label) { fill: var(--pp-ink-2); }
:where(.pp-grid) { stroke: var(--pp-grid); stroke-width: 1; shape-rendering: crispEdges; }
:where(.pp-baseline) { stroke: var(--pp-axis); stroke-width: 1; shape-rendering: crispEdges; }
:where(.pp-line) { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
:where(.pp-dot) { stroke: var(--pp-surface); stroke-width: 2; }
:where(.pp-hair) { stroke: var(--pp-axis); stroke-width: 1; }
:where(.pp-band-highlight) { fill: var(--pp-ink); opacity: 0.04; }
:where(.pp-tooltip) { position: absolute; z-index: 1; min-width: 96px; max-width: 260px; padding: 8px 10px;
  border: 1px solid var(--pp-border); border-radius: 8px; background: var(--pp-surface);
  box-shadow: 0 6px 20px rgb(22 22 26 / 0.1); font-size: 12px; pointer-events: none; }
:where(.pp-tip-heading) { margin-bottom: 4px; color: var(--pp-ink-2); }
:where(.pp-tip-row) { display: flex; align-items: center; gap: 6px; }
:where(.pp-tip-row strong) { font-weight: 650; font-variant-numeric: tabular-nums; }
:where(.pp-tip-name) { overflow: hidden; color: var(--pp-ink-2); text-overflow: ellipsis; white-space: nowrap; }
:where(.pp-table-view, .pp-table-wrap) { max-height: 360px; margin-top: 10px; overflow: auto; }
:where(.pp-table) { width: 100%; border-collapse: collapse; font-size: 13px; }
:where(.pp-table th) { position: sticky; top: 0; background: var(--pp-surface); color: var(--pp-ink-2); font-weight: 600; text-align: left; }
:where(.pp-table th, .pp-table td) { padding: 6px 10px; border-bottom: 1px solid var(--pp-grid); white-space: nowrap; }
:where(.pp-num) { text-align: right; font-variant-numeric: tabular-nums; }
:where(.pp-table th.pp-num) { text-align: right; }
:where(.pp-notes:empty) { display: none; }
:where(.pp-note) { margin: 8px 0 0; color: var(--pp-muted); font-size: 12px; }
:where(.pp-stat-label) { color: var(--pp-ink-2); font-size: 13px; }
:where(.pp-stat-value) { margin-top: 2px; font-size: 32px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.15; }
:where(.pp-stat-delta) { display: flex; gap: 6px; align-items: center; margin-top: 4px; color: var(--pp-ink-2); font-size: 13px; }
:where(.pp-stat-delta.pp-good .pp-delta-icon) { color: var(--pp-good); }
:where(.pp-stat-delta.pp-bad .pp-delta-icon) { color: var(--pp-bad); }
:where(.pp-delta-icon) { font-size: 10px; }
:where(.pp-loading) { color: var(--pp-muted); font-size: 13px; }
:where(.pp-error, .pp-page-error) { color: var(--pp-bad); font-size: 13px; }
:where(.pp-page-error) { margin-bottom: 16px; padding: 10px 14px; border: 1px solid #f0c9c6; border-radius: 10px; background: #fdf1f0; }
`;
  (document.head ?? document.documentElement).prepend(style);

  window.pawpaw = Object.freeze({
    load,
    nav,
    barChart,
    lineChart,
    stat,
    table,
    format: formatValue,
    colours: PALETTE.slice(),
    // For tests (tests/node/report-charts.test.ts).
    _internal: {
      niceTicks,
      timeTicks,
      parseTime,
      formatValue,
      buildSeries,
      toRows,
    },
  });
})();
