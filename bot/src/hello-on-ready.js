export async function sendStartupHello(client, config) {
  if (!config?.notifyChannelId) return;
  try {
    const channel = await client.channels.fetch(config.notifyChannelId);
    if (!channel?.isTextBased?.()) return;
    await channel.send("hello");
    console.log(`[startup] sent hello to ${config.notifyChannelId}`);
  } catch (err) {
    console.error("[startup] failed to send hello:", err?.message);
  }
}
