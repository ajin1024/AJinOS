export const dingTalkKeyword = "AJinOS";
export const otherPlatformSetupOpen = false;

export const notificationPlatforms = {
  dingtalk: {
    name: "钉钉",
    destination: "钉钉群",
    steps: [
      "在电脑端打开目标钉钉群，进入「群设置 → 机器人 → 添加机器人」。",
      "选择「自定义」机器人。在安全设置里选择「自定义关键词」，添加 AJinOS。",
      "保存机器人，复制它的 Webhook 地址。",
    ],
    address: (url) => url.hostname === "oapi.dingtalk.com" && url.pathname === "/robot/send" && url.searchParams.get("access_token"),
  },
  wecom: {
    name: "企微",
    destination: "企业微信群",
    steps: [
      "在企业微信电脑端进入目标群，打开「管理聊天信息」。",
      "选择「消息推送 → 自定义消息推送」，填写名称并添加。",
      "复制群机器人详情里显示的 Webhook 地址。",
    ],
    address: (url) => url.hostname === "qyapi.weixin.qq.com" && url.pathname === "/cgi-bin/webhook/send" && url.searchParams.get("key"),
  },
  slack: {
    name: "Slack",
    destination: "Slack 频道",
    steps: [
      "打开 Slack 应用管理页，在目标工作区创建或打开已有应用。",
      "启用 Incoming Webhooks，选择 Add New Webhook to Workspace。",
      "选择要接收通知的频道并授权，然后复制 Webhook URL。",
    ],
    address: (url) => ["hooks.slack.com", "hooks.slack-gov.com"].includes(url.hostname) && /^\/services\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname),
  },
  discord: {
    name: "Discord",
    destination: "Discord 频道",
    steps: [
      "打开目标服务器的「服务器设置 → 整合 → Webhooks」。",
      "创建 Webhook，选择接收通知的文字频道并保存。",
      "点击 Copy Webhook URL 复制地址。",
    ],
    address: (url) => ["discord.com", "discordapp.com"].includes(url.hostname) && /^\/api\/webhooks\/\d+\/[^/]+$/.test(url.pathname),
  },
};

export function channelAddress(platform, input) {
  if (!Object.hasOwn(notificationPlatforms, platform) || typeof input !== "string" || input.length > 2048) return null;
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
    return notificationPlatforms[platform].address(url) ? url.href : null;
  } catch {
    return null;
  }
}
