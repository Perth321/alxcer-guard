// tools_openclaw.js — OpenClaw: local code execution + web deployment + self-awareness
// run_code: executes code directly on the GitHub Actions Ubuntu runner (python3, node,
//   go, rust, g++, java, ruby, php, bash, perl, lua, etc. — all pre-installed).
//   No external API needed — runs LOCALLY and RELIABLY.
// deploy_webpage: creates a GitHub Gist + htmlpreview.github.io URL.

import { exec as _exec } from "child_process";
import { promisify } from "util";
import { writeFile, unlink, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const exec = promisify(_exec);
const RUN_TIMEOUT_MS = 15_000;
const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 3000; // chars

// ─── Language config ──────────────────────────────────────────────────────────
const LANG_ALIAS = {
  py: "python", python3: "python", python2: "python",
  js: "javascript", ts: "typescript", nodejs: "javascript",
  "c++": "cpp", "c#": "csharp", sh: "bash", shell: "bash",
  rb: "ruby", rs: "rust", kt: "kotlin", cs: "csharp", golang: "go",
};

const LANG_EXT = {
  python: "py", javascript: "js", typescript: "ts", bash: "sh",
  go: "go", rust: "rs", cpp: "cpp", c: "c", java: "java",
  php: "php", ruby: "rb", kotlin: "kt", csharp: "cs",
  perl: "pl", lua: "lua", r: "r", swift: "swift", scala: "scala",
};

// How to compile/run each language on Ubuntu (GitHub Actions runner)
const LANG_RUN = {
  python:     (f, d) => `python3 "${f}"`,
  javascript: (f, d) => `node "${f}"`,
  typescript: (f, d) => `npx --yes tsx "${f}" 2>&1 || ts-node --skipProject "${f}"`,
  bash:       (f, d) => `bash "${f}"`,
  go:         (f, d) => `cd "${d}" && go run main.go`,
  rust:       (f, d) => `rustc -o "${d}/out" "${f}" 2>&1 && "${d}/out"`,
  cpp:        (f, d) => `g++ -O2 -o "${d}/out" "${f}" 2>&1 && "${d}/out"`,
  c:          (f, d) => `gcc -O2 -o "${d}/out" "${f}" 2>&1 && "${d}/out"`,
  ruby:       (f, d) => `ruby "${f}"`,
  php:        (f, d) => `php "${f}"`,
  perl:       (f, d) => `perl "${f}"`,
  lua:        (f, d) => `lua5.4 "${f}" 2>/dev/null || lua "${f}"`,
  r:          (f, d) => `Rscript "${f}"`,
  // Java: extract class name, compile + run
  java:       null,
  // Kotlin: might not be installed
  kotlin:     (f, d) => `kotlinc "${f}" -include-runtime -d "${d}/out.jar" 2>&1 && java -jar "${d}/out.jar"`,
  csharp:     (f, d) => `dotnet-script "${f}" 2>&1 || echo 'C# (dotnet-script) not available'`,
  scala:      (f, d) => `scala "${f}"`,
};

function normalizeLang(l) {
  const s = (l || "").toLowerCase().trim().replace(/[^a-z0-9#+]/g, "");
  return LANG_ALIAS[s] || s;
}

// ─── run_code: Execute code LOCALLY on the Actions runner ────────────────────
export async function runCode(language, code, stdin = "") {
  const lang = normalizeLang(language);
  const ext  = LANG_EXT[lang] || "txt";
  const dir  = join(tmpdir(), "botcode_" + Date.now() + "_" + Math.random().toString(36).slice(2));
  
  try {
    await mkdir(dir, { recursive: true });
    const file = join(dir, "main." + ext);
    await writeFile(file, code, "utf8");
    
    // Build command
    let cmd;
    if (lang === "java") {
      const cls = (code.match(/public\s+class\s+(\w+)/) || [])[1] || "Main";
      const jf  = join(dir, cls + ".java");
      await writeFile(jf, code, "utf8");
      cmd = `javac "${jf}" -d "${dir}" 2>&1 && java -cp "${dir}" ${cls}`;
    } else if (LANG_RUN[lang]) {
      cmd = LANG_RUN[lang](file, dir);
    } else {
      return { error: `Language '${lang}' is not supported. Supported: python, javascript, typescript, bash, go, rust, cpp, c, ruby, php, perl, lua, r, java, kotlin` };
    }
    
    // Prepend stdin if provided
    if (stdin) {
      const escaped = stdin.replace(/'/g, "'\''");
      cmd = `echo '${escaped}' | (${cmd})`;
    }
    
    const { stdout, stderr } = await exec(cmd, {
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      cwd: dir,
    });
    
    const out = (stdout || "").slice(0, MAX_OUTPUT);
    const err = (stderr || "").slice(0, 800);
    return {
      language: lang,
      output:   out,
      stderr:   err || undefined,
      note:     out.length >= MAX_OUTPUT ? "(output truncated)" : undefined,
    };
  } catch (e) {
    if (e.killed || e.code === "ETIMEDOUT") {
      return { error: `Timed out after ${RUN_TIMEOUT_MS / 1000}s`, language: lang };
    }
    const out = (e.stdout || "").slice(0, MAX_OUTPUT);
    const err = (e.stderr || e.message || "execution error").slice(0, 800);
    return { language: lang, output: out || undefined, error: err };
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── deploy_webpage ────────────────────────────────────────────────────────────
export async function deployWebpage(filename, html, description = "") {
  // GH_PAT has gist scope; GITHUB_TOKEN (Actions auto-token) cannot create Gists
  const token = process.env.GH_PAT || process.env.GITHUB_TOKEN;
  if (!token) return { error: "GH_PAT not set — cannot create Gist. Add GH_PAT secret to repo." };

  const fname = /\.html?$/i.test(filename) ? filename : `${filename}.html`;

  try {
    const res = await fetch("https://api.github.com/gists", {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        description: description || `Alxcer Guard deploy: ${fname}`,
        public: true,
        files: { [fname]: { content: html } },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      return { error: e.message || `GitHub API ${res.status}` };
    }

    const gist = await res.json();
    const rawUrl   = gist.files[fname]?.raw_url || "";
    const previewUrl = rawUrl
      ? `https://htmlpreview.github.io/?${rawUrl}`
      : gist.html_url;

    return {
      ok: true,
      gist_id:     gist.id,
      gist_url:    gist.html_url,
      preview_url: previewUrl,
      raw_url:     rawUrl,
      note: "เปิดดูได้ทันทีผ่าน htmlpreview.github.io — ไม่ต้อง login",
    };
  } catch (err) {
    return { error: err?.message || "deploy failed" };
  }
}

// ─── Read latest GitHub Actions log ──────────────────────────────────────────
export async function readOwnLog(lines = 100, filter = "") {
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return { error: "GITHUB_TOKEN / GITHUB_REPOSITORY not set" };

  const H = { Authorization: `token ${token}`, Accept: "application/vnd.github+json" };

  try {
    const runsRes = await fetch(
      `https://api.github.com/repos/${repo}/actions/runs?per_page=2`,
      { headers: H, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    const runsData = await runsRes.json();
    const run = (runsData.workflow_runs || [])[0];
    if (!run) return { error: "No runs found" };

    const jobsRes = await fetch(
      `https://api.github.com/repos/${repo}/actions/runs/${run.id}/jobs`,
      { headers: H, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    const jobsData = await jobsRes.json();
    const job = (jobsData.jobs || [])[0];
    if (!job) return { error: "No jobs found" };

    const logRes = await fetch(job.logs_url, {
      headers: H, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!logRes.ok) return { error: `Log fetch failed: ${logRes.status}` };

    const raw = await logRes.text();
    let logLines = raw.split("\n").filter(l => !filter || l.toLowerCase().includes(filter.toLowerCase()));
    logLines = logLines.slice(-Math.min(lines, 300));
    return { run_id: run.id, job: job.name, lines: logLines };
  } catch (err) {
    return { error: err?.message || "readOwnLog failed" };
  }
}

// ─── Read own source file ────────────────────────────────────────────────────
export async function readOwnSource(filepath) {
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return { error: "GITHUB_TOKEN / GITHUB_REPOSITORY not set" };
  if (!filepath?.startsWith("bot/")) return { error: "Only bot/* paths allowed" };

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${filepath}`,
      { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) return { error: `GitHub ${res.status}` };
    const d = await res.json();
    const content = Buffer.from(d.content, "base64").toString("utf8");
    return { filepath, lines: content.split("\n").length, content };
  } catch (err) {
    return { error: err?.message || "readOwnSource failed" };
  }
}

// ─── Write/patch own source (triggers redeploy) ──────────────────────────────
export async function writeOwnSource(filepath, content, commitMessage = "") {
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return { error: "GITHUB_TOKEN / GITHUB_REPOSITORY not set" };
  if (!filepath?.startsWith("bot/src/")) return { error: "Only bot/src/* files allowed for safety" };

  try {
    // Get current SHA
    const getRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${filepath}`,
      { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    const existing = getRes.ok ? await getRes.json() : null;
    const sha = existing?.sha;

    const body = {
      message: commitMessage || `fix: self-patch ${filepath} via agent`,
      content: Buffer.from(content).toString("base64"),
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${filepath}`,
      {
        method: "PUT",
        headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!putRes.ok) {
      const e = await putRes.json().catch(() => ({}));
      return { error: e.message || `GitHub ${putRes.status}` };
    }
    const d = await putRes.json();
    return { ok: true, commit: d.commit?.sha?.slice(0, 8), filepath, note: "Redeploy triggered automatically (new push → new run)" };
  } catch (err) {
    return { error: err?.message || "writeOwnSource failed" };
  }
}
