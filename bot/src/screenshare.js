// screenshare.js — removed. Feature was experimental and has been disabled.
// All exports are stubs that return an error message.
export const isActive = () => false;
export const getStatus = () => ({ active: false });
export const startScreenShare = async () => ({ error: "Screen share feature removed" });
export const stopScreenShare = async () => ({ ok: true });
