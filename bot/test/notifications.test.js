import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

let importSequence = 0;

async function importFreshNotifications() {
  const url = new URL("../src/notifications.js", import.meta.url);
  url.searchParams.set("test", String(++importSequence));
  return import(url.href);
}

test("notification CRUD and panel views are isolated by guild", async () => {
  const notifications = await importFreshNotifications();
  const legacy = notifications.addNotification({
    time: "08:00",
    label: "legacy",
    message: "legacy message",
  });
  const guildA = notifications.addNotification({
    guildId: "guild-a",
    time: "09:00",
    label: "only-a",
    message: "message a",
  });
  const guildB = notifications.addNotification({
    guildId: "guild-b",
    time: "10:00",
    label: "only-b",
    message: "message b",
  });

  assert.deepEqual(
    notifications.listNotifications("guild-a").map((item) => item.id),
    [guildA.id],
  );
  assert.deepEqual(
    notifications.listNotifications("guild-b").map((item) => item.id),
    [guildB.id],
  );
  assert.equal(notifications.getNotification(legacy.id, "guild-a"), null);
  assert.equal(
    notifications.updateNotification(guildA.id, { label: "wrong" }, "guild-b"),
    null,
  );
  assert.equal(notifications.removeNotification(guildA.id, "guild-b"), false);
  assert.equal(notifications.getNotification(guildA.id, "guild-a").label, "only-a");

  const panelA = notifications.buildPanelView("guild-a");
  const description = panelA.embeds[0].data.description;
  assert.match(description, /only-a/);
  assert.doesNotMatch(description, /only-b|legacy/);

  const migrated = notifications.assignNotificationGuild(legacy.id, "guild-c");
  assert.equal(migrated.guildId, "guild-c");
  assert.equal(notifications.listNotifications("guild-c").length, 1);
  assert.equal(notifications.exportData().version, 2);
});

test("scheduler runs guilds independently and never broadcasts legacy items", async () => {
  const notifications = await importFreshNotifications();
  const fixedNow = Date.UTC(2026, 0, 2, 5, 34, 0); // 12:34 Asia/Bangkok
  notifications.addNotification({
    time: "12:34",
    label: "legacy",
    message: "must not fire",
    channelId: "legacy-channel",
  });
  notifications.addNotification({
    guildId: "guild-a",
    time: "12:34",
    label: "guild a",
    message: "send a",
    channelId: "channel-a",
  });
  notifications.addNotification({
    guildId: "guild-b",
    time: "12:34",
    label: "guild b",
    message: "send b",
    channelId: "channel-b",
  });

  const sends = [];
  const fetchedGuilds = [];
  const client = {
    guilds: {
      async fetch(guildId) {
        fetchedGuilds.push(guildId);
        return {
          channels: {
            async fetch(channelId) {
              return {
                isTextBased: () => true,
                async send(payload) {
                  sends.push({ guildId, channelId, payload });
                },
              };
            },
          },
        };
      },
    },
  };

  await Promise.all([
    notifications.tickScheduler({
      client,
      guildId: "guild-a",
      defaultChannelId: "default-a",
      now: fixedNow,
      persist: false,
    }),
    notifications.tickScheduler({
      client,
      guildId: "guild-b",
      defaultChannelId: "default-b",
      now: fixedNow,
      persist: false,
    }),
  ]);

  assert.deepEqual(new Set(fetchedGuilds), new Set(["guild-a", "guild-b"]));
  assert.deepEqual(
    sends.map(({ guildId, channelId }) => `${guildId}:${channelId}`).sort(),
    ["guild-a:channel-a", "guild-b:channel-b"],
  );
  assert.equal(sends.some((send) => send.channelId === "legacy-channel"), false);

  // lastFiredYMD is per item, so repeated ticks on the same Bangkok day no-op.
  await notifications.tickScheduler({
    client,
    guildId: "guild-a",
    now: fixedNow,
    persist: false,
  });
  assert.equal(sends.length, 2);
});

test("notification component creation takes guildId from the interaction", async () => {
  const previousWrite = fs.writeFileSync;
  fs.writeFileSync = () => {};
  try {
    const notifications = await importFreshNotifications();
    const replies = [];
    const interaction = {
      customId: "notify:add-modal",
      guildId: "guild-ui",
      member: { permissions: { has: () => true } },
      memberPermissions: { has: () => true },
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      fields: {
        getTextInputValue(name) {
          return { time: "13:45", label: "ui item", message: "from ui" }[name];
        },
      },
      async reply(payload) {
        replies.push(payload);
      },
    };

    assert.equal(await notifications.handleNotifyComponent(interaction), true);
    assert.equal(replies.length, 1);
    assert.equal(notifications.listNotifications("guild-ui").length, 1);
    assert.equal(notifications.listNotifications("another-guild").length, 0);
    assert.equal(
      notifications.listNotifications("guild-ui")[0].guildId,
      "guild-ui",
    );
  } finally {
    fs.writeFileSync = previousWrite;
  }
});
