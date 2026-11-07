# Third-party references and notices

T3 Code (T3 Tools Inc.), source pin ce2815d665acb0dedc028c12109d3b7aebbcc134. Journal cursor/recovery, connection and scoped identity patterns informed observer0.6. The implementation is adapted to the existing dependency-free Node/browser observer; the upstream application and dependency tree are not bundled. Upstream: https://github.com/pingdotgg/t3code

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


JetBrains Mono fonts retain their SIL Open Font License in public/assets/fonts/OFL.txt.

Optional historical analytics uses DuckDB 1.5.6 (Stichting DuckDB Foundation),
installed separately through scripts/analytics-requirements.txt. DuckDB is MIT
licensed; its package retains the copyright and license notice. No DuckDB
binary or Python environment is bundled in this source package. Ordinary hub,
collector and browser operation do not require it. Upstream:
https://github.com/duckdb/duckdb


## Native Windows Community runtime bundle

Community 0.1.0 local-test installer includes Node.js 24.19.0 (Node.js contributors; MIT and bundled third-party terms), CPython 3.13.5 (Python Software Foundation and contributors; PSF and bundled third-party terms), and DuckDB Python 1.5.6 (DuckDB contributors; MIT and bundled notices). Exact downloaded archive/wheel digests are pinned in scripts/build-windows-installer.mjs. BUILD_RECEIPT.json binds the installer and payload manifest; that manifest records each extracted payload file hash. Preserve runtimes/node/LICENSE, runtimes/python/LICENSE.txt and runtimes/python/Lib/site-packages/duckdb-1.5.6.dist-info/licenses with the binaries. Those components are not authored by ARGELLAN. The Windows-provided .NET Framework desktop runtime is used by the native setup executable; no framework binaries are redistributed. No pip/npm package installation is required on the target machine.
