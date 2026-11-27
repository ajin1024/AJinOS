// The smallest channel there is: anything that takes a JSON POST (a group robot in DingTalk, WeCom, Slack, Discord…).
// Words and a link, no buttons: pair it with "links": true in rules.json so the link itself can answer that one card.
//   "channels": { "dingtalk": { "use": "webhook", "key": "…", "url": "https://…",
//                               "body": { "msgtype": "text", "text": { "content": "{text}" } } } }
import { accepted, payload } from "./templates.ts";
import type { Card, ChannelContext } from "../../host/channels.ts";

function fill(template: unknown, text: string): unknown {
  if (typeof template === "string") return template.replaceAll("{text}", () => text);
  if (Array.isArray(template)) return template.map((item) => fill(item, text));
  if (template && typeof template === "object") {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, fill(value, text)]));
  }
  return template;
}

// WeCom draws its messages as Markdown: a link or a tag in what an Agent wrote would be drawn, and could pass off a link
// of its own as the card's. Full-width look-alikes keep the words and stop the markup; bare addresses still become links.
const asWords = (text: string) => text.replaceAll("](", "］(").replaceAll("<", "＜");

function words(card: Card, platform = "") {
  if (platform === "wecom")
    card = { ...card, title: asWords(card.title), text: asWords(card.text), options: card.options.map(asWords) };
  const source = platform === "wecom" && card.rule ? `来源：${asWords(card.rule)}` : "";
  const title = card.ticket ? `[${card.ticket}] ${card.title}` : card.title;
  if (
    platform === "wecom" &&
    card.kind === "notice" &&
    card.state === "open" &&
    card.options.length === 1 &&
    card.options[0] === "已处理" &&
    card.link
  )
    return [title, source, card.text, `[点击处理](${card.link})`].filter(Boolean).join("\n\n");
  const choices = card.options.map((option, index) => `${index + 1}. ${option}`).join("\n");
  // A channel that can only send words gets the card's own page as the close button.
  const closeLink =
    card.ticketState?.closeable && card.link
      ? platform === "wecom"
        ? `[一键关闭任务](${card.link})`
        : `一键关闭任务：${card.link}`
      : "";
  const parts = [title, source, card.text, ...(card.state === "open" ? [choices, card.link] : []), closeLink];
  return parts.filter(Boolean).join("\n\n");
}

export default async function webhook({ hub, options, log, signal }: ChannelContext) {
  while (!signal.aborted) {
    let card: Card | null;
    try {
      ({ card } = await hub.nextCard(50));
    } catch (error) {
      log(`couldn't reach the hub: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      continue;
    }
    if (!card) continue;
    // It can't change a message once sent: an update has nothing to do.
    if (card.ref) {
      await hub.delivered(card.id, card.version, card.ref);
      continue;
    }
    try {
      const platform = String(options.platform ?? "");
      const text = words(card, platform);
      const content = platform === "dingtalk" && options.keyword ? `${options.keyword}\n${text}` : text;
      const response = await fetch(options.url as string, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(platform ? payload(platform, content) : fill(options.body ?? { text: "{text}" }, text)),
        signal: AbortSignal.timeout(30_000),
      });
      await accepted(platform, response);
      await hub.delivered(card.id, card.version, `sent-${card.id}`);
    } catch (error) {
      log(`card ${card.id} not sent: ${error}`);
      await hub.failed(card.id, card.version, String(error)).catch(() => {});
    }
  }
}
