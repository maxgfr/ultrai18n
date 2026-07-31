#!/usr/bin/env node

// src/cli.ts
import { resolve } from "path";

// src/version.ts
var VERSION = "0.0.0";

// src/census.ts
import { spawnSync } from "child_process";
import { join as join2 } from "path";

// src/vendor/walk.ts
import { readdirSync, statSync, lstatSync, readFileSync, realpathSync } from "fs";
import { join, relative, sep, extname } from "path";

// src/vendor/util.ts
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// src/vendor/ignore.ts
function patternToRegExpSource(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      re += escapeRegExp(pattern[++i]);
    } else if (c === "*") {
      if (pattern[i + 1] === "*") {
        const atStart = i === 0 || pattern[i - 1] === "/";
        let j = i;
        while (pattern[j + 1] === "*") j++;
        const next = pattern[j + 1];
        if (atStart && next === "/") {
          i = j + 1;
          re += "(?:[^/]+/)*";
        } else if (atStart && next === void 0) {
          i = j;
          re += ".*";
        } else {
          i = j;
          re += "[^/]*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      let j = i + 1;
      let body = "";
      if (pattern[j] === "!") {
        body += "^";
        j++;
      }
      if (pattern[j] === "]") {
        body += "\\]";
        j++;
      }
      while (j < pattern.length && pattern[j] !== "]") {
        const ch = pattern[j];
        body += ch === "\\" || ch === "^" ? "\\" + ch : ch;
        j++;
      }
      if (j < pattern.length && body !== "" && body !== "^") {
        re += `[${body}]`;
        i = j;
      } else {
        re += "\\[";
      }
    } else {
      re += escapeRegExp(c);
    }
  }
  return re;
}
function parseGitignore(content, baseRel) {
  const rules = [];
  const prefix = baseRel ? escapeRegExp(baseRel) + "/" : "";
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.replace(/(?<!\\) +$/, "");
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (!line) continue;
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    const body = patternToRegExpSource(line);
    const source = anchored ? `^${prefix}${body}$` : `^${prefix}(?:[^/]+/)*${body}$`;
    try {
      rules.push({ re: new RegExp(source), negated, dirOnly });
    } catch {
    }
  }
  return rules;
}
function isIgnored(rules, rel, isDir) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.re.test(rel)) ignored = !rule.negated;
  }
  return ignored;
}

// src/vendor/walk.ts
var IGNORE_DIRS = /* @__PURE__ */ new Set([
  ".git",
  "node_modules",
  ".pnpm",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".gradle",
  ".idea",
  ".vscode",
  ".cache",
  "tmp",
  ".ultraindex",
  ".codeindex",
  ".ultrai18n",
  "Pods",
  "DerivedData",
  ".terraform",
  "elm-stuff",
  ".dart_tool"
]);
var LOCKFILES = /* @__PURE__ */ new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "composer.lock",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "gemfile.lock",
  "go.sum",
  "flake.lock",
  "packages.lock.json",
  "podfile.lock",
  "mix.lock"
]);
var BINARY_EXT = /* @__PURE__ */ new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".icns",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".jar",
  ".war",
  ".class",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".bin",
  ".o",
  ".a",
  ".wasm",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".webm",
  ".wav",
  ".flac",
  ".ogg",
  ".lock",
  ".min.js",
  ".map"
]);
var TEXT_BEARING_BINARY_EXT = /* @__PURE__ */ new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".icns",
  ".pdf",
  ".mp4",
  ".mov",
  ".avi",
  ".webm",
  ".mp3",
  ".wav",
  ".flac",
  ".ogg",
  ".docx",
  ".doc",
  ".xlsx",
  ".xls",
  ".pptx",
  ".ppt",
  ".odt",
  ".ods",
  ".odp",
  ".sqlite",
  ".sqlite3",
  ".db"
]);
function walk(root, opts = {}) {
  const maxFileBytes = opts.maxFileBytes ?? 1024 * 1024;
  const maxFiles = opts.maxFiles ?? Infinity;
  const useGitignore = opts.gitignore !== false;
  const ignoreDirs = opts.ignoreDirs ? new Set(opts.ignoreDirs) : IGNORE_DIRS;
  const out = [];
  const skipped = [];
  const skippedDirs = [];
  let capped = false;
  let rootReal;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { files: out, capped, skipped, skippedDirs };
  }
  const contained = (real) => real === rootReal || real.startsWith(rootReal + sep);
  const stack = [
    { dir: root, rel: "", rules: [] }
  ];
  const seenDirs = /* @__PURE__ */ new Set();
  walking: while (stack.length) {
    const frame = stack.pop();
    let real;
    try {
      real = realpathSync(frame.dir);
    } catch {
      continue;
    }
    if (seenDirs.has(real)) continue;
    seenDirs.add(real);
    if (!contained(real)) continue;
    let entries;
    try {
      entries = readdirSync(frame.dir, { withFileTypes: true }).sort(
        (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      );
    } catch {
      continue;
    }
    let rules = frame.rules;
    if (useGitignore && entries.some((e) => e.name === ".gitignore")) {
      const parsed = parseGitignore(readGitignore(join(frame.dir, ".gitignore")), frame.rel);
      if (parsed.length) rules = [...rules, ...parsed];
    }
    for (const entry of entries) {
      const name = entry.name;
      const abs = join(frame.dir, name);
      const rel = frame.rel ? `${frame.rel}/${name}` : name;
      const isLink = entry.isSymbolicLink();
      if (entry.isDirectory() && ignoreDirs.has(name)) {
        skippedDirs.push({ rel, reason: "ignore-dir" });
        continue;
      }
      let st;
      try {
        st = isLink ? statSync(abs) : lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (ignoreDirs.has(name)) {
          skippedDirs.push({ rel, reason: "ignore-dir" });
          continue;
        }
        if (isLink) continue;
        if (useGitignore && rules.length && isIgnored(rules, rel, true)) {
          skippedDirs.push({ rel, reason: "gitignored" });
          continue;
        }
        stack.push({ dir: abs, rel, rules });
        continue;
      }
      if (!st.isFile()) continue;
      const ext = extname(name).toLowerCase();
      const isBinaryExt = BINARY_EXT.has(ext);
      const isLockfile = LOCKFILES.has(name.toLowerCase());
      const isMinified = name.endsWith(".min.js") || name.endsWith(".min.css");
      const isOversize = st.size > maxFileBytes;
      if (useGitignore && rules.length && isIgnored(rules, rel, false)) {
        skipped.push({ rel, reason: "gitignored", size: st.size });
        continue;
      }
      if (isOversize && !opts.includeOversize) {
        skipped.push({ rel, reason: "over-max-bytes", size: st.size });
        continue;
      }
      if (isLockfile && !opts.includeLockfiles) {
        skipped.push({ rel, reason: "lockfile", size: st.size });
        continue;
      }
      if (isBinaryExt && !opts.includeBinary) {
        skipped.push({
          rel,
          reason: "binary-ext",
          textBearing: TEXT_BEARING_BINARY_EXT.has(ext),
          size: st.size
        });
        continue;
      }
      if (isMinified) {
        skipped.push({ rel, reason: "minified", size: st.size });
        continue;
      }
      if (isLink) {
        try {
          if (!contained(realpathSync(abs))) {
            skipped.push({ rel, reason: "symlink-outside-root" });
            continue;
          }
        } catch {
          continue;
        }
      }
      if (out.length >= maxFiles) {
        capped = true;
        break walking;
      }
      out.push({ rel: rel.split(sep).join("/"), abs, size: st.size, ext, mtimeMs: st.mtimeMs });
    }
  }
  out.sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  skipped.sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  skippedDirs.sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  return { files: out, capped, skipped, skippedDirs };
}
function readGitignore(abs) {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return "";
  }
}

// src/vendor/text.ts
import { readFileSync as readFileSync2 } from "fs";
var EMPTY = {
  text: "",
  buf: Buffer.alloc(0),
  encoding: null,
  binary: false,
  bytes: 0,
  ok: false,
  byteAddressable: false,
  bodyStart: 0
};
function readTextEx(abs) {
  let buf;
  try {
    buf = readFileSync2(abs);
  } catch {
    return EMPTY;
  }
  const bytes = buf.length;
  const base = { buf, bytes, ok: true, binary: false };
  if (bytes >= 2 && buf[0] === 255 && buf[1] === 254) {
    const text2 = buf.subarray(2, 2 + (bytes - 2 & ~1)).toString("utf16le");
    return { ...base, text: text2, encoding: "utf16le", byteAddressable: false, bodyStart: 2 };
  }
  if (bytes >= 2 && buf[0] === 254 && buf[1] === 255) {
    const swapped = Buffer.from(buf.subarray(2, 2 + (bytes - 2 & ~1)));
    swapped.swap16();
    return {
      ...base,
      text: swapped.toString("utf16le"),
      encoding: "utf16be",
      byteAddressable: false,
      bodyStart: 2
    };
  }
  if (bytes >= 3 && buf[0] === 239 && buf[1] === 187 && buf[2] === 191) {
    return {
      ...base,
      text: buf.subarray(3).toString("utf8"),
      encoding: "utf8-bom",
      byteAddressable: true,
      bodyStart: 3
    };
  }
  if (buf.includes(0)) {
    return { ...base, text: "", encoding: null, binary: true, byteAddressable: false, bodyStart: 0 };
  }
  const text = buf.toString("utf8");
  if (text.includes("\uFFFD")) {
    return {
      ...base,
      text: buf.toString("latin1"),
      encoding: "latin1",
      byteAddressable: false,
      bodyStart: 0
    };
  }
  return { ...base, text, encoding: "utf8", byteAddressable: true, bodyStart: 0 };
}

// src/census.ts
function gitLsFiles(root) {
  const r = spawnSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 1 << 28 });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.toString("utf8").split("\0").filter(Boolean).sort();
}
function runCensus(root) {
  const tracked = gitLsFiles(root);
  const source = tracked ? "git" : "filesystem";
  const scan = walk(root);
  const walked = new Map(scan.files.map((f) => [f.rel, f]));
  const skippedByRel = new Map(scan.skipped.map((s) => [s.rel, s]));
  const skippedDirs = scan.skippedDirs;
  const denominator = tracked ?? [...scan.files.map((f) => f.rel), ...scan.skipped.map((s) => s.rel)].sort();
  const entries = [];
  const unaccounted = [];
  for (const rel of denominator) {
    const file = walked.get(rel);
    if (file) {
      const read = readTextEx(file.abs);
      if (!read.ok) {
        entries.push({ file: rel, bucket: "skipped", reason: "unreadable" });
        continue;
      }
      if (read.binary) {
        entries.push({
          file: rel,
          bucket: "skipped",
          reason: "nul-byte",
          mustVerifyManually: false,
          bytesTotal: read.bytes
        });
        continue;
      }
      entries.push({
        file: rel,
        bucket: read.text.trim() === "" ? "scanned-zero" : "scanned",
        bytesTotal: read.bytes,
        degraded: !read.byteAddressable,
        ...read.byteAddressable ? {} : { reason: `encoding:${read.encoding}` }
      });
      continue;
    }
    const skipped = skippedByRel.get(rel);
    if (skipped) {
      entries.push(skippedEntry(rel, skipped));
      continue;
    }
    const dir = skippedDirs.find((d) => rel === d.rel || rel.startsWith(d.rel + "/"));
    if (dir) {
      entries.push({
        file: rel,
        bucket: "skipped",
        reason: dir.reason,
        mustVerifyManually: false
      });
      continue;
    }
    unaccounted.push(rel);
    entries.push({ file: rel, bucket: "skipped", reason: "unaccounted" });
  }
  entries.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  const totals = {
    tracked: denominator.length,
    scanned: entries.filter((e) => e.bucket === "scanned").length,
    scannedZero: entries.filter((e) => e.bucket === "scanned-zero").length,
    skipped: entries.filter((e) => e.bucket === "skipped").length,
    unscannable: entries.filter((e) => e.mustVerifyManually).length,
    unaccounted: unaccounted.length
  };
  return {
    source,
    entries,
    totals,
    unaccounted,
    ok: unaccounted.length === 0 && totals.scanned + totals.scannedZero + totals.skipped === totals.tracked
  };
}
function skippedEntry(rel, s) {
  const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
  const textBearing = s.textBearing ?? TEXT_BEARING_BINARY_EXT.has(ext);
  return {
    file: rel,
    bucket: "skipped",
    reason: s.reason,
    // An image or a PDF is unreadable by the engine but perfectly readable by a
    // person. Reporting it identically to a font file tells the user nothing,
    // and that is how a translated app ships with English screenshots.
    mustVerifyManually: textBearing,
    ...s.size !== void 0 ? { bytesTotal: s.size } : {}
  };
}
function formatCensus(r, root) {
  const lines = [];
  lines.push(
    `ultrai18n census  ${root}  (${r.source === "git" ? "git ls-files" : "filesystem \u2014 weaker claim"})`
  );
  lines.push("");
  lines.push(
    `  ${r.totals.tracked} tracked = ${r.totals.scanned} scanned + ${r.totals.scannedZero} empty + ${r.totals.skipped} skipped`
  );
  const unscannable = r.entries.filter((e) => e.mustVerifyManually);
  if (unscannable.length) {
    lines.push("");
    lines.push(`UNSCANNABLE \u2014 carries text a person can read, but the engine cannot (${unscannable.length})`);
    for (const e of unscannable) lines.push(`  ${e.file}${e.producedBy ? `   regenerable: ${e.producedBy}` : ""}`);
  }
  if (r.unaccounted.length) {
    lines.push("");
    lines.push(`UNACCOUNTED \u2014 tracked, neither read nor explained (${r.unaccounted.length})`);
    for (const f of r.unaccounted) lines.push(`  ${f}`);
  }
  lines.push("");
  lines.push(r.ok ? "G1 census-complete  ok" : "G1 census-complete  FAIL");
  return lines.join("\n");
}

// src/cli.ts
var HELP = `ultrai18n v${VERSION} \u2014 find every human-readable string, and prove nothing was missed

Usage:
  ultrai18n scan       [--repo <dir>] [--from auto|<lang>] [--to <lang>] [--out <dir>] [--json]
  ultrai18n census     [--repo <dir>] [--json]
  ultrai18n sites      [--verdict <v>] [--surface <glob>] [--file <glob>] [--dup] [--json]
  ultrai18n catalog    [--explain <file>] [--ecosystem <id>] [--rule <id>] [--json]
  ultrai18n lang       [--value "<text>"] [--test] [--json]
  ultrai18n adjudicate [--out <dir>] [--batch <n>]
  ultrai18n plan       [--out <dir>] [--mode audit|swap|i18n|sync] [--json]
  ultrai18n translate  [--backend <k>] [--translator '<cmd>'] [--apply "<glob>"] [--json]
  ultrai18n apply      [--write] [--out <dir>] [--json]
  ultrai18n verify     [--apply <verdicts.json>] [--max-verify <n>] [--json]
  ultrai18n check      [--from <lang>] [--to <lang>] [--semantic] [--new-only] [--json]
  ultrai18n sync       [--catalog <glob>] [--source-locale <lang>] [--json]
  ultrai18n glossary   [--seed] [--list] [--json]
  ultrai18n orchestrate [--phase <name>] [--eco] [--list]
  ultrai18n init       [--ci] [--hook] [--baseline]
  ultrai18n version

Commands:
  census      Account for every tracked path: scanned, empty, or skipped with a
              reason. The denominator is \`git ls-files\`, not the walker, because
              the walker's own exclusions are what needs auditing. Exits 1 when
              any tracked path is unaccounted for (gate G1).

Options:
  --repo <dir>   Repository root (default: cwd)
  --out <dir>    Run directory (default: <repo>/.ultrai18n)
  --json         Machine-readable output on stdout; human lines go to stderr
  --to <lang>    Target language (default: en)

Exit codes:
  0  ok
  1  a gate failed, or the command could not run
  2  usage error, or an orchestrate phase is not ready
`;
var COMMANDS = /* @__PURE__ */ new Set([
  "scan",
  "census",
  "sites",
  "catalog",
  "lang",
  "adjudicate",
  "plan",
  "translate",
  "apply",
  "verify",
  "check",
  "sync",
  "glossary",
  "orchestrate",
  "init",
  "version"
]);
var VALUE_FLAGS = /* @__PURE__ */ new Set([
  "repo",
  "out",
  "from",
  "to",
  "verdict",
  "surface",
  "file",
  "explain",
  "ecosystem",
  "rule",
  "value",
  "batch",
  "mode",
  "backend",
  "translator",
  "apply",
  "max-verify",
  "catalog",
  "source-locale",
  "phase",
  "sample-rate",
  "translator-timeout",
  "config"
]);
var BOOL_FLAGS = /* @__PURE__ */ new Set([
  "json",
  "dup",
  "test",
  "write",
  "semantic",
  "new-only",
  "seed",
  "list",
  "eco",
  "ci",
  "hook",
  "baseline",
  "quiet",
  "no-sweep",
  "allow-dirty",
  "no-git",
  "backup",
  "strict",
  "help"
]);
function fail(msg) {
  process.stderr.write(`ultrai18n: ${msg}
`);
  process.exit(1);
}
function usage(msg) {
  process.stderr.write(`ultrai18n: ${msg}
`);
  process.exit(2);
}
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  let command = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      const name = eq === -1 ? body : body.slice(0, eq);
      if (VALUE_FLAGS.has(name)) {
        const value = eq === -1 ? argv[++i] : body.slice(eq + 1);
        if (value === void 0) usage(`--${name} needs a value`);
        flags[name] = value;
      } else if (BOOL_FLAGS.has(name)) {
        flags[name] = true;
      } else {
        usage(`unknown flag: --${name}`);
      }
      continue;
    }
    if (!command && COMMANDS.has(arg)) command = arg;
    else positional.push(arg);
  }
  return { command, positional, flags };
}
var PENDING = {
  scan: "the extractors (ts-ast, json, yaml) are not built yet",
  sites: "requires `scan`",
  catalog: "the surface catalog is not built yet",
  lang: "the language detector is not built yet",
  adjudicate: "requires `scan`",
  plan: "requires `scan`",
  translate: "requires `plan`",
  apply: "requires `translate`",
  verify: "requires `apply`",
  check: "requires `scan` \u2014 run `census` for gate G1 alone",
  sync: "requires the catalog extractors",
  glossary: "requires `plan`",
  orchestrate: "requires `plan`",
  init: "requires `check`"
};
function main() {
  const p = parseArgs(process.argv.slice(2));
  if (p.flags.help || !p.command && p.positional.length === 0) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (!p.command) usage(`unknown command: ${p.positional[0]}`);
  const repo = resolve(String(p.flags.repo ?? process.cwd()));
  const json = p.flags.json === true;
  switch (p.command) {
    case "version":
      process.stdout.write(`${VERSION}
`);
      return;
    case "census": {
      const result = runCensus(repo);
      if (json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        process.stdout.write(formatCensus(result, repo) + "\n");
      }
      if (!result.ok) process.exit(1);
      return;
    }
    default: {
      const why = PENDING[p.command];
      fail(`\`${p.command}\` is not implemented in this build \u2014 ${why}`);
    }
  }
}
main();
export {
  parseArgs
};
