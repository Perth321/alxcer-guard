import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

let importSequence = 0;

async function importFreshTranscripts() {
  const url = new URL("../src/transcripts.js", import.meta.url);
  url.searchParams.set("test", String(++importSequence));
  return import(url.href);
}

test("transcripts retain guild/channel metadata and filter every query by guild", async () => {
  const previousWrite = fs.writeFileSync;
  const writes = [];
  fs.writeFileSync = (file, contents) => {
    writes.push({ file: String(file), contents: String(contents) });
  };

  try {
    const transcripts = await importFreshTranscripts();
    transcripts.addTranscript({
      guildId: "guild-a",
      channelId: "channel-a1",
      userId: "same-user",
      username: "A",
      text: "flagged in a1",
      flagged: true,
      flaggedWord: "bad-a",
    });
    transcripts.addTranscript({
      guildId: "guild-a",
      channelId: "channel-a2",
      userId: "user-a2",
      username: "A2",
      text: "clean in a2",
    });
    transcripts.addTranscript({
      guildId: "guild-b",
      channelId: "channel-b1",
      userId: "same-user",
      username: "B",
      text: "flagged in b",
      flagged: true,
      flaggedWord: "bad-b",
    });
    // Legacy records remain readable through the unfiltered API, but never
    // leak into a guild-scoped query.
    transcripts.addTranscript({
      userId: "legacy-user",
      text: "legacy",
      flagged: true,
      flaggedWord: "legacy-bad",
    });

    assert.equal(transcripts.getRecent().length, 4);
    assert.deepEqual(
      transcripts.getRecent({ guildId: "guild-a" }).map((entry) => entry.text),
      ["flagged in a1", "clean in a2"],
    );
    assert.deepEqual(
      transcripts
        .getRecent({ guildId: "guild-a", channelId: "channel-a1" })
        .map((entry) => entry.text),
      ["flagged in a1"],
    );
    assert.deepEqual(
      transcripts.getRecent({ guildId: "guild-b" }).map((entry) => entry.text),
      ["flagged in b"],
    );

    const statsA = transcripts.getStats({ guildId: "guild-a" });
    assert.equal(statsA.totalEntries, 2);
    assert.equal(statsA.flagged, 1);
    const statsA1 = transcripts.getStats({
      guildId: "guild-a",
      channelId: "channel-a1",
    });
    assert.equal(statsA1.totalEntries, 1);
    assert.equal(statsA1.flagged, 1);

    const cursingA = transcripts.getCursingStats({ guildId: "guild-a" });
    assert.equal(cursingA.totals.utterances, 2);
    assert.equal(cursingA.totals.flagged, 1);
    assert.equal(cursingA.users.some((user) => user.username === "B"), false);
    assert.deepEqual(cursingA.users[0].words, { "bad-a": 1 });

    const cursingB = transcripts.getCursingStats({ guildId: "guild-b" });
    assert.equal(cursingB.totals.utterances, 1);
    assert.equal(cursingB.totals.flagged, 1);
    assert.deepEqual(cursingB.users[0].words, { "bad-b": 1 });

    assert.ok(writes.length >= 4);
    const persisted = JSON.parse(writes.at(-1).contents);
    assert.equal(persisted.version, 2);
    assert.equal(persisted.entries[0].guildId, "guild-a");
    assert.equal(persisted.entries[0].channelId, "channel-a1");
    assert.equal(persisted.entries[3].guildId, null);
    assert.equal(persisted.entries[3].channelId, null);
  } finally {
    fs.writeFileSync = previousWrite;
  }
});

test("guild and channel identifiers are snapshotted as strings", async () => {
  const previousWrite = fs.writeFileSync;
  fs.writeFileSync = () => {};
  try {
    const transcripts = await importFreshTranscripts();
    const entry = {
      guildId: 123,
      channelId: 456,
      userId: "user",
      text: "numeric ids",
    };
    transcripts.addTranscript(entry);
    entry.guildId = 999;
    entry.channelId = 999;

    const result = transcripts.getRecent({ guildId: 123, channelId: 456 });
    assert.equal(result.length, 1);
    assert.equal(result[0].guildId, "123");
    assert.equal(result[0].channelId, "456");
    assert.equal(transcripts.getRecent({ guildId: 999 }).length, 0);
  } finally {
    fs.writeFileSync = previousWrite;
  }
});
