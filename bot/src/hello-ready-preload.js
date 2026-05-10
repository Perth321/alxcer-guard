import { Client } from "discord.js";
import { loadConfig } from "./config.js";

const originalEmit = Client.prototype.emit;
let sent = false;

Client.prototype.emit = function patchedEmit(eventName, ...args) {
  const result = originalEmit.call(this, eventName, ...args);

  if ((eventName === "ready" || eventName === "clientReady") && !sent) {
    sent = true;
    queueMicrotask(async () => {
      try {
        const config = loadConfig();
        if (!config.notifyChannelId) {
          console.warn("[startup] hello skipped: notifyChannelId is empty");
          return;
        }

        const channel = await this.channels.fetch(config.notifyChannelId);
        if (!channel?.isTextBased?.()) {
          console.warn("[startup] hello skipped: notifyChannelId is not text based");
          return;
        }

        await channel.send("hello");
        console.log(`[startup] sent hello to ${config.notifyChannelId}`);
      } catch (err) {
        console.error("[startup] failed to send hello:", err?.message);
      }
    });
  }

  return result;
};
