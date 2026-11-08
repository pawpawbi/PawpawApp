# Writing the report

A project's report is a small static website in its `report/` folder: plain HTML, CSS and
JavaScript, with the data it shows saved alongside as JSON. It needs nothing from PawpawBI, so
the folder can be hosted anywhere, such as an S3 bucket behind a CDN. In the app, **Build
visuals** shows it and edits its files and datasets; **Publish** hosts it on PawpawBI, saves it
as a single HTML file to send by email, or writes it to a folder for hosting anywhere. File layout: [pawpaw-file-format.md](../pawpaw-file-format.md).

Two parts work together:

1. **Datasets** turn tables into the data a chart needs, with SQL. Each is saved as
   `data/<name>.json` whenever the data is loaded or refreshed.
2. **Pages** draw charts from datasets with the chart library, `assets/charts.js`.

## Rules

- **Everything comes from the folder.** No scripts, stylesheets, fonts or images from the
  internet: the report must work offline and on any host, and the app blocks outside requests.
  Use relative paths (`../assets/report.css`); put images in `assets/` or inline them as `data:`
  URLs.
- **Plain HTML, CSS and JavaScript.** No frameworks and no build step.
- **Data only from datasets.** Pages can't query tables; add or change a dataset instead.
- **Group in SQL.** A dataset publishes exactly what its query returns, to anyone who can see the
  report. Return what the charts need (totals by month, top 10), not raw rows, and never columns
  that shouldn't be published. Limits: 50,000 rows and 10 MB per dataset.

## Datasets

A dataset is a name and one read-only `SELECT` (DuckDB SQL) over any table, loaded or
transformed, by name, as the Model data screen shows it. Names are lowercase letters, digits and
underscores, starting with a letter: `revenue_by_month`.

```sql
SELECT CAST(date_trunc('month', order_date) AS DATE) AS month,
       region,
       sum(revenue) AS revenue
FROM orders
GROUP BY 1, 2
ORDER BY 1, 2
```

- Name columns the way charts will use them (`AS revenue`).
- `ORDER BY` decides the order of bars, table rows and series colours.
- Dates and timestamps arrive as ISO text (`2024-03-01`, `2024-03-01T06:30:00`) and are shown as
  they are, without converting time zones. Cast to `DATE` for daily or monthly data.
- One dataset can feed several charts.

## Pages

Each page is `pages/<guid>.html` and is listed in `report.json`. Pages don't contain the
report's menu (its title and a link to every page): the app shows it above the page, and
Publish writes the same menu into each page. Don't add navigation to a page. A
new page starts empty (a heading, a "Nothing on this page yet" section to remove, and an empty
`grid`). A finished page looks like this:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Revenue</title>
    <link rel="stylesheet" href="../assets/report.css" />
    <script src="../assets/charts.js"></script>
  </head>
  <body>
    <main class="page">
      <h1>Revenue</h1>
      <div class="stats">
        <div id="total"></div>
      </div>
      <div class="grid">
        <div id="by-month"></div>
        <div id="by-region"></div>
      </div>
    </main>
    <script>
      pawpaw.stat('#total', 'totals', {
        label: 'Revenue',
        value: 'revenue',
        format: 'currency',
      });
      pawpaw.lineChart('#by-month', 'revenue_by_month', {
        x: 'month',
        y: 'revenue',
        series: 'region',
        title: 'Revenue by month',
        format: 'currency',
      });
      pawpaw.barChart('#by-region', 'revenue_by_region', {
        title: 'Revenue by region',
        format: 'currency',
      });
    </script>
  </body>
</html>
```

Layout classes from `assets/report.css`: `page` (the content column), `stats` (a row of headline
numbers), `grid` (charts, two columns on wide screens, one on phones), `wide` (a chart across
the whole grid) and `empty-state` (the new page's placeholder). `pawpaw.nav(target)` lists the
pages, for the landing page (`index.html`); pages don't use it.

Each chart function takes a **target** (a CSS selector or element), the **data** and
**options**. It turns the target into a card, shows "Loading…", then the chart, or a short
message saying what went wrong (for example a dataset that doesn't exist yet, or a misspelled
column). One broken chart doesn't stop the others; errors elsewhere in a page's scripts show at
the top of the page.

The data can be a **dataset name**, an array of row objects, or a promise of one.
`pawpaw.load(name)` loads a dataset for your own code: it resolves to an array of row objects, which
also has `columns` (the column names, in order), `truncated` and `generatedAt`.

```js
const rows = await pawpaw.load('orders_by_region');
pawpaw.barChart(
  '#busy',
  rows.filter((r) => r.orders > 10),
  { title: 'Busy regions' },
);
```

## Charts

Options for bar and line charts (`stat` and `table` have their own, below):

| Option     | Meaning                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `title`    | Heading on the card.                                                                                |
| `subtitle` | A smaller line under it, e.g. the unit or period.                                                   |
| `format`   | How values are shown: `'number'` (default), `'percent'` (0.25 is 25%), `'currency'`, or a function. |
| `currency` | Currency code for `'currency'`, e.g. `'GBP'`. Default `'USD'`.                                      |
| `height`   | Plot height in pixels (default 280). Horizontal bar charts size themselves.                         |

Bar and line charts have a **Show table** button with the same numbers, a tooltip on hover (and
with the arrow keys after tabbing to it), and a legend when there's more than one series.

### Series

`barChart` and `lineChart` draw one or more series:

- **One:** `x` is the category or date column, `y` the value. They default to the dataset's first
  and second columns.
- **Several value columns:** `y: ['actual', 'budget']`, named with
  `labels: { actual: 'Actual', budget: 'Budget' }`.
- **A series column:** `series: 'region'` draws one series per region, with `y` as the value.

Rows with the same `x` (and series) are added together. At most eight series are drawn: the
seven largest stay and the rest are added together as "Other". Colours are given in order of
first appearance, so `ORDER BY` controls them.

### pawpaw.barChart(target, data, options)

Bars from zero. `orientation: 'vertical' | 'horizontal'`; by default bars are horizontal when
labels are long or there are more than 12. With one series and up to 15 bars, each bar shows its
value when it fits. At most 50 bars are drawn.

### pawpaw.lineChart(target, data, options)

Lines over dates, numbers or categories, detected from `x` (or set `xType: 'time' | 'number' |
'category'`). Dates and numbers are sorted; categories keep the data's order. A missing value
leaves a gap. `zero: true` always starts the value axis at zero, `false` fits it to the data; by
default it starts at zero unless the values are all far from it. With up to four series, line
ends are labelled when the labels don't collide.

### pawpaw.stat(target, data, options)

A headline number from the first row. `label` says what it is; `value` picks the column (default:
the first). `delta` names a column with the change, shown as "Up 8.4% vs last year" with an
arrow, with `deltaFormat`, `deltaLabel` and `upIsGood` (default `true`; `false` makes increases
red, e.g. for costs). The data can also be a number: `pawpaw.stat('#n', 42, { label: 'Answer' })`.

### pawpaw.table(target, data, options)

Rows as a table. `columns` (which, in order), `labels` (headings), `format` (one, or one per
column: `{ revenue: 'currency' }`), `currency`, `title`, `maxRows` (default 500).

### Other helpers

- `pawpaw.format(value, format, { compact, currency })`: a value as text, as charts show it.
- `pawpaw.colours`: the eight series colours, in order.

## Styling

Styles live in `assets/report.css` and pages' own `<style>` elements. The charts' built-in styles
have the lowest priority, so any rule overrides them. Colours are CSS variables:

| Variable                               | Used for                                      |
| -------------------------------------- | --------------------------------------------- |
| `--pp-page`                            | Page background                               |
| `--pp-surface`, `--pp-border`          | Cards                                         |
| `--pp-ink`, `--pp-ink-2`, `--pp-muted` | Text, secondary text, axes                    |
| `--pp-grid`, `--pp-axis`               | Gridlines and the zero line                   |
| `--pp-accent`                          | The current page, focus                       |
| `--pp-good`, `--pp-bad`                | Up and down in headline numbers; chart errors |
| `--pp-font`                            | Font (the system font)                        |

The eight series colours were chosen to be told apart by colour-blind readers, in this order.
Don't reorder them or add more; fold extra series into "Other" instead.

## Hosting

**Publish** refreshes every dataset, copies the folder into an empty folder you choose and writes
the menu into every page. Upload
its contents as they are, e.g. `aws s3 sync <folder> s3://<bucket>/<prefix>` and, behind
CloudFront, invalidate the old files. The hosted report is a snapshot: publish again to update it.
Anyone who can reach the site can read its data files, so put private reports behind access
control. Browsers won't load the data when `index.html` is opened straight from disk; use a web
server.

**Save as a single file** (also on Publish) refreshes every dataset and puts the whole report,
its pages, files and data, into one HTML file to send by email or share like any other file. It
opens in a web browser straight from disk, with no internet. Pages work there as they do when
hosted, as long as they get data from datasets (chart functions, `pawpaw.load`, or fetching
`data/<name>.json`) and refer to images and fonts by relative paths in their HTML or CSS. Requests
to anywhere else are blocked, and links to other websites open in a new tab. Anyone with the file
can read all of its data, and it doesn't update: save it again for new data.
