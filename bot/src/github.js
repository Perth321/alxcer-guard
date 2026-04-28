const API = "https://api.github.com";

function getRepo() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !repo.includes("/")) return null;
  const [owner, name] = repo.split("/");
  return { owner, name };
}

function getToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}

function getBranch() {
  return process.env.GITHUB_REF_NAME || "main";
}

export function canPersistRemotely() {
  return !!(getRepo() && getToken());
}

async function ghFetch(url, options = {}) {
  const token = getToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "alxcer-guard-bot",
      ...(options.headers || {}),
    },
  });
  return res;
}

async function commitFile(filePath, contentString, message) {
  const repo = getRepo();
  if (!repo) throw new Error("GITHUB_REPOSITORY env not set");
  if (!getToken()) throw new Error("GITHUB_TOKEN env not set");

  const branch = getBranch();
  const url = `${API}/repos/${repo.owner}/${repo.name}/contents/${filePath}`;

  let sha;
  const head = await ghFetch(`${url}?ref=${encodeURIComponent(branch)}`);
  if (head.ok) {
    const data = await head.json();
    sha = data.sha;
  } else if (head.status !== 404) {
    const text = await head.text();
    throw new Error(`GitHub GET failed: ${head.status} ${text}`);
  }

  const contentB64 = Buffer.from(contentString, "utf8").toString("base64");

  const put = await ghFetch(url, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: contentB64,
      branch,
      sha,
      committer: {
        name: "Alxcer Guard Bot",
        email: "alxcer-guard@users.noreply.github.com",
      },
    }),
  });

  if (!put.ok) {
    const text = await put.text();
    throw new Error(`GitHub PUT failed: ${put.status} ${text}`);
  }
}

export async function commitConfig(configObject, message = "chore: update bot config via /setting") {
  await commitFile(
    "bot/config.json",
    JSON.stringify(configObject, null, 2) + "\n",
    message,
  );
}

export async function commitOffenses(offensesObject, message = "chore: update offense tracker") {
  await commitFile(
    "bot/offenses.json",
    JSON.stringify(offensesObject, null, 2) + "\n",
    message,
  );
}
