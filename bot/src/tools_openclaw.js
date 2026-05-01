// tools_openclaw.js — OpenClaw: code execution, web deployment, self-awareness
// All free, using GITHUB_TOKEN (auto-injected by GitHub Actions) for GitHub ops
// and Piston API (emkc.org) for sandboxed code execution.

const TIMEOUT_MS = 30_000;
const PISTON_BASE = "https://emkc.org/api/v2/piston";

// ─── Piston language aliases ──────────────────────────────────────────────────
const LANG_ALIAS = {
  py: "python", python3: "python", js: "javascript", ts: "typescript",
  "c++": "cpp", "c#": "csharp", sh: "bash", shell: "bash", rb: "ruby",
  rs: "rust", kt: "kotlin", cs: "csharp",
};
function normalizeLang(l) {
  const s = (l || "").toLowerCase().trim();
  return LANG_ALIAS[s] || s;
}
function langExt(l) {
  const map = {
    python: "py", javascript: "js", typescript: "ts", bash: "sh",
    go: "go", rust: "rs", cpp: "cpp", c: "c", java: "java",
    php: "php", ruby: "rb", kotlin: "kt", csharp: "cs",
  };
  return map[l] || "txt";
}

// ─── Run code via Piston (free sandboxed execution) ───────────────────────────
export async function runCode(language, code, stdin = "") {
  const lang = normalizeLang(language);
  try {
    const res = await fetch(`${PISTON_BASE}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: lang,
        version: "*",
        files: [{ name: `main.${langExt(lang)}`, content: code }],
        stdin: stdin || "",
        run_timeout: 20000,
        compile_timeout: 15000,
        run_memory_limit: 134217728, // 128 MiB
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      if (res.status === 400) {
        // Often means unsupported language — list available ones
        const rtRes = await fetch(`${PISTON_BASE}/runtimes`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
        const rt = rtRes?.ok ? await rtRes.json().catch(() => []) : [];
        const langs = rt.map((r) => r.language).join(", ");
        return {
          error: `Language "${lang}" not supported. Available: ${langs.slice(0, 500)}`,
        };
      }
      return { error: `Piston ${res.status}: ${txt.slice(0, 200)}` };
    }

    const data = await res.json();
    const run = data.run ?? {};
    const compile = data.compile ?? {};
    const stdout = (run.stdout || "").slice(0, 3000);
    const stderr = (run.stderr || compile.stderr || compile.output || "").slice(0, 1000);
    const exitCode = run.code ?? compile.code ?? -1;
    const timedOut = run.signal === "SIGKILL" || compile.signal === "SIGKILL";

    return {
      language: data.language,
      version: data.version,
      stdout: stdout || "(no output)",
      stderr: stderr || undefined,
      exit_code: exitCode,
      timed_out: timedOut || undefined,
      ok: !compile.stderr && exitCode === 0 && !timedOut,
    };
  } catch (err) {
    return { error: err?.message || "code execution failed" };
  }
}

// ─── Deploy HTML as GitHub Gist → htmlpreview.github.io URL ──────────────────
export async function deployWebpage(filename, html, description = "") {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { error: "GITHUB_TOKEN not available — cannot deploy" };

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
    const rawUrl = gist.files[fname]?.raw_url || "";
    const previewUrl = rawUrl
      ? `https://htmlpreview.github.io/?${rawUrl}`
      : gist.html_url;

    return {
      ok: true,
      gist_id: gist.id,
      gist_url: gist.html_url,
      preview_url: previewUrl,
      raw_url: rawUrl,
      note: "เปิดดูได้ทันทีผ่าน htmlpreview.github.io — ไม่ต้อง login",
    };
  } catch (err) {
    return { error: err?.message || "deploy failed" };
  }
}

// ─── Read latest GitHub Actions log ──────────────────────────────────────────
export async function readOwnLog(lines = 100, filter = "") {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return { error: "GITHUB_TOKEN / GITHUB_REPOSITORY not set" };

  const H = { Authorization: `token ${token}`, Accept: "application/vnd.github+json" };

  try {
    const runsRes = await fetch(
      `https://api.github.com/repos/${repo}/actions/runs?per_page=2`,
      { headers: H, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    const runsData = await runsRes.json();
    const run = runsData.workflow_runs?.[0];
    if (!run) return { error: "ไม่พบ workflow runs" };

    const jobsRes = await fetch(
      `https://api.github.com/repos/${repo}/actions/runs/${run.id}/jobs`,
      { headers: H, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    const jobsData = await jobsRes.json();
    const job = jobsData.jobs?.[0];
    if (!job) return { error: "ไม่พบ jobs", run_status: run.status };

    const logRes = await fetch(
      `https://api.github.com/repos/${repo}/actions/jobs/${job.id}/logs`,
      { headers: H, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) },
    );

    const meta = {
      run_id: run.id,
      run_status: run.status,
      run_conclusion: run.conclusion,
      head_sha: run.head_sha?.slice(0, 8),
      job_name: job.name,
      job_status: job.status,
      job_conclusion: job.conclusion,
    };

    if (!logRes.ok) {
      return { ...meta, note: "Log not yet available (run still starting up)" };
    }

    let logLines = (await logRes.text()).split("\n");
    if (filter) {
      logLines = logLines.filter((l) =>
        l.toLowerCase().includes(filter.toLowerCase()),
      );
    }
    const maxLines = Math.min(Math.max(lines, 10), 300);
    const sliced = logLines.slice(-maxLines);

    return {
      ...meta,
      log_lines: sliced.length,
      log: sliced.join("\n").slice(0, 6000),
    };
  } catch (err) {
    return { error: err?.message || "log fetch failed" };
  }
}

// ─── Read a source file from own GitHub repo ─────────────────────────────────
export async function readOwnSource(filepath) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const branch = process.env.GITHUB_REF_NAME || "main";
  if (!token || !repo) return { error: "GITHUB_TOKEN / GITHUB_REPOSITORY not set" };

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${filepath}?ref=${branch}`,
      {
        headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      return { error: e.message || `HTTP ${res.status}` };
    }
    const data = await res.json();
    if (data.encoding !== "base64") return { error: "unexpected encoding" };
    const content = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
    return {
      filepath,
      sha: data.sha,
      size: data.size,
      lines: content.split("\n").length,
      content: content.slice(0, 8000),
      truncated: content.length > 8000,
    };
  } catch (err) {
    return { error: err?.message || "source read failed" };
  }
}

// ─── Write a source file to own GitHub repo (self-healing) ───────────────────
// Safety: only bot/src/* and bot/config.json are allowed; never workflow files.
const SELF_WRITE_ALLOWED = ["bot/src/", "bot/config.json"];

export async function writeOwnSource(filepath, content, commitMessage) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const branch = process.env.GITHUB_REF_NAME || "main";
  if (!token || !repo) return { error: "GITHUB_TOKEN / GITHUB_REPOSITORY not set" };

  const allowed = SELF_WRITE_ALLOWED.some((p) => filepath.startsWith(p));
  if (!allowed) {
    return {
      error: `ไม่อนุญาตให้แก้ไข ${filepath} — อนุญาตเฉพาะ bot/src/* และ bot/config.json เท่านั้น`,
    };
  }
  // Block workflow file tampering even if named differently
  if (filepath.includes(".github/") || filepath.endsWith(".yml") || filepath.endsWith(".yaml")) {
    return { error: "ไม่อนุญาตให้แก้ไขไฟล์ workflow" };
  }

  const H = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };

  try {
    // Get current SHA (required for updating existing files)
    const infoRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${filepath}?ref=${branch}`,
      { headers: H, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    let sha = null;
    if (infoRes.ok) {
      const info = await infoRes.json().catch(() => ({}));
      sha = info.sha || null;
    }

    const body = {
      message: commitMessage?.slice(0, 200) || `fix: self-patch ${filepath}`,
      content: Buffer.from(content).toString("base64"),
      branch,
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${filepath}`,
      { method: "PUT", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!putRes.ok) {
      const e = await putRes.json().catch(() => ({}));
      return { error: e.message || `HTTP ${putRes.status}` };
    }
    const result = await putRes.json();
    return {
      ok: true,
      filepath,
      commit_sha: result.commit?.sha?.slice(0, 8),
      commit_url: result.commit?.html_url,
      note: "บันทึกแล้ว — GitHub Actions จะรีสตาร์ทบอทอัตโนมัติภายใน ~30 วินาที",
    };
  } catch (err) {
    return { error: err?.message || "source write failed" };
  }
}
