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

const fileCommitQueues = new Map();

async function commitFileNow(filePath, contentString, message) {
  const repo = getRepo();
  if (!repo) throw new Error("GITHUB_REPOSITORY env not set");
  if (!getToken()) throw new Error("GITHUB_TOKEN env not set");

  const branch = getBranch();
  const url = `${API}/repos/${repo.owner}/${repo.name}/contents/${filePath}`;
  const contentB64 = Buffer.from(contentString, "utf8").toString("base64");

  // Retry up to 3 times on 409 SHA conflict (two concurrent commits can
  // race between the GET-sha and PUT, causing a 422/409 from GitHub).
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let sha;
    const head = await ghFetch(`${url}?ref=${encodeURIComponent(branch)}`);
    if (head.ok) {
      const data = await head.json();
      sha = data.sha;
    } else if (head.status !== 404) {
      const text = await head.text();
      throw new Error(`GitHub GET failed: ${head.status} ${text}`);
    }

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

    if (put.ok) return;

    // 409 = SHA conflict — another commit landed between our GET and PUT.
    // Re-fetch the latest SHA and try again.
    if ((put.status === 409 || put.status === 422) && attempt < MAX_RETRIES) {
      const delay = attempt * 1500;
      console.warn(`[github] commitFile conflict (attempt ${attempt}/${MAX_RETRIES}) for ${filePath} — retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    const text = await put.text();
    throw new Error(`GitHub PUT failed: ${put.status} ${text}`);
  }
}

function commitFile(filePath, contentString, message) {
  const previous = fileCommitQueues.get(filePath) || Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(() => commitFileNow(filePath, contentString, message));
  fileCommitQueues.set(filePath, task);
  task.finally(() => {
    if (fileCommitQueues.get(filePath) === task) fileCommitQueues.delete(filePath);
  }).catch(() => {});
  return task;
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

export async function commitNotifications(
  data,
  message = "chore: update notifications via /notify",
) {
  await commitFile(
    "bot/notifications.json",
    JSON.stringify(data, null, 2) + "\n",
    message,
  );
}

export async function commitStudy(
  data,
  message = "chore: persist study quiz state",
) {
  await commitFile(
    "bot/study.json",
    JSON.stringify(data, null, 2) + "\n",
    message,
  );
}

export async function commitTranscripts(
  transcriptsObject,
  message = "chore: persist voice transcript history",
) {
  await commitFile(
    "bot/transcripts.json",
    JSON.stringify(transcriptsObject) + "\n",
    message,
  );
}

export async function commitUpdateNotes(data, message = "chore: clear update notes after posting") {
  await commitFile(
    "bot/update_notes.json",
    JSON.stringify(data, null, 2) + "\n",
    message,
  );
}

export async function commitAutomations(data, message = "chore: persist automation schedules") {
  await commitFile(
    "bot/automations.json",
    JSON.stringify(data, null, 2) + "\n",
    message,
  );
}

export async function commitTimers(data, message = "chore: persist active timers") {
  await commitFile(
    "bot/timers.json",
    JSON.stringify(data, null, 2) + "\n",
    message,
  );
}

export async function commitMuteLeases(data, message = "chore: persist Guard mute ownership") {
  await commitFile(
    "bot/mute_leases.json",
    JSON.stringify(data, null, 2) + "\n",
    message,
  );
}
