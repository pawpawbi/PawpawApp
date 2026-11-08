# Third-party notices

PawpawBI includes software from the projects below, each under its own licence. This file lists
what's shipped in the app; full licence texts are included in the app as described.
**Update it when a bundled dependency is added, removed or changed.**

Last reviewed: 2026-10-17, for app version 1.0.0.

## Electron and Chromium

- **Electron** 44.7.2, MIT. Electron bundles **Chromium**, **Node.js** and other components under
  their own licences. Their notices ship with every build as `LICENSE` and
  `LICENSES.chromium.html` in the app folder.

## JavaScript (bundled into the app)

| Package                                            | Version      | Licence    |
| -------------------------------------------------- | ------------ | ---------- |
| vue (and its `@vue/*` runtime packages)            | 3.5.44       | MIT        |
| yazl                                               | 3.3.1        | MIT        |
| yauzl                                              | 3.4.0        | MIT        |
| buffer-crc32 (yauzl/yazl dependency)               | 1.0.0        | MIT        |
| pend (yauzl dependency)                            | 1.2.0        | MIT        |
| electron-squirrel-startup                          | 1.0.1        | Apache-2.0 |
| debug, ms (electron-squirrel-startup dependencies) | 4.4.3, 2.1.3 | MIT        |

## Fonts

| Font          | Package                             | Licence                   |
| ------------- | ----------------------------------- | ------------------------- |
| Fraunces      | @fontsource-variable/fraunces 5.3.0 | SIL Open Font License 1.1 |
| IBM Plex Sans | @fontsource/ibm-plex-sans 5.3.0     | SIL Open Font License 1.1 |
| IBM Plex Mono | @fontsource/ibm-plex-mono 5.3.0     | SIL Open Font License 1.1 |

## Python runtime

- **CPython** 3.12.15, Python Software Foundation License. Built by
  [python-build-standalone](https://github.com/astral-sh/python-build-standalone) (release
  20261001), which includes components such as OpenSSL, SQLite, zlib, libffi, bzip2, xz and Tcl/Tk
  under their own licences. The full texts ship as `resources\python\runtime\LICENSE.txt`.
- **Microsoft Visual C++ runtime** (`vcruntime140.dll`, `vcruntime140_1.dll`), redistributed
  under Microsoft's Visual Studio redistributable terms.
- **pip** 26.2.1, MIT.

## Python packages (bundled)

Each package's own licence file ships in its `*.dist-info` folder under
`resources\python\runtime\Lib\site-packages\`.

| Package             | Version     | Licence                         |
| ------------------- | ----------- | ------------------------------- |
| dlt                 | 1.30.0      | Apache-2.0                      |
| pyarrow             | 25.0.1      | Apache-2.0                      |
| duckdb              | 1.5.6       | MIT                             |
| SQLAlchemy          | 2.0.54      | MIT                             |
| greenlet            | 3.5.6       | MIT AND PSF-2.0                 |
| openpyxl            | 3.1.5       | MIT                             |
| et_xmlfile          | 2.0.0       | MIT                             |
| certifi             | 2026.7.22   | MPL-2.0                         |
| charset-normalizer  | 3.5.2       | MIT                             |
| click               | 8.5.0       | BSD-3-Clause                    |
| fsspec              | 2026.9.0    | BSD-3-Clause                    |
| gitdb               | 4.0.12      | BSD-3-Clause                    |
| GitPython           | 3.2.0       | BSD-3-Clause                    |
| giturlparse         | 0.15.0      | Apache-2.0                      |
| humanize            | 4.16.0      | MIT                             |
| idna                | 3.20        | BSD-3-Clause                    |
| jsonpath-ng         | 1.8.0       | Apache-2.0                      |
| markdown-it-py      | 4.2.0       | MIT                             |
| mdurl               | 0.1.2       | MIT                             |
| orjson              | 3.12.0      | MPL-2.0 AND (Apache-2.0 OR MIT) |
| packaging           | 26.3        | Apache-2.0 OR BSD-2-Clause      |
| pathvalidate        | 3.3.1       | MIT                             |
| pendulum            | 3.2.0       | MIT                             |
| pluggy              | 1.6.0       | MIT                             |
| Pygments            | 2.21.0      | BSD-2-Clause                    |
| python-dateutil     | 2.9.0.post0 | Apache-2.0 OR BSD-3-Clause      |
| pytz                | 2026.4      | MIT                             |
| pywin32             | 312         | PSF                             |
| PyYAML              | 6.0.3       | MIT                             |
| requests            | 2.34.2      | Apache-2.0                      |
| requirements-parser | 0.13.1      | Apache-2.0                      |
| rich                | 15.0.0      | MIT                             |
| rich-argparse       | 1.8.0       | MIT                             |
| semver              | 3.1.0       | BSD-3-Clause                    |
| setuptools          | 84.0.0      | MIT                             |
| simplejson          | 4.1.2       | MIT OR AFL-2.1                  |
| six                 | 1.17.0      | MIT                             |
| smmap               | 5.0.3       | BSD-3-Clause                    |
| sqlglot             | 30.21.0     | MIT                             |
| tenacity            | 9.1.4       | Apache-2.0                      |
| tomlkit             | 0.15.1      | MIT                             |
| typing_extensions   | 4.16.0      | PSF-2.0                         |
| tzdata              | 2026.4      | Apache-2.0                      |
| urllib3             | 2.8.0       | MIT                             |
| win-precise-time    | 1.4.2       | MIT                             |

MPL-2.0 (certifi, orjson) is a file-level copyleft: if we modify those packages' files we must
share those changes. We use them unmodified.

## dlt verified sources (vendored)

`python/sidecar/verified_sources/` contains connectors copied unmodified from
[dlt-hub/verified-sources](https://github.com/dlt-hub/verified-sources) (commit `3957506`),
Apache License 2.0. The licence text ships alongside them as `verified_sources\LICENSE`.

## Downloaded on first use (not shipped)

Some connectors download extra Python packages from PyPI the first time they're used (each connector's
`packages` in `python/sidecar/connectors/`). They aren't distributed with PawpawBI;
each is installed on the user's computer under its own licence, which ships with it. Before adding
a connector, check its packages' licences are acceptable.
