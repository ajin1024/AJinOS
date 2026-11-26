import React, { useState } from "react";
import { Banner, Button, SideSheet } from "@douyinfe/semi-ui";
import { IconChevronRight, IconLink, IconTickCircle } from "@douyinfe/semi-icons";
import { channelAddress, notificationPlatforms, otherPlatformSetupOpen } from "../channel-platforms.mjs";

export function NotificationChannelSheet({ api, snapshot, onClose, onSaved, onCustomSource }) {
  const [platform, setPlatform] = useState("");
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const selected = notificationPlatforms[platform];
  const labels = ["选平台", "准备连接", "填写信息", "确认保存"];

  function choose(id, provider) {
    setPlatform(id);
    setName(`${provider.name}通知`);
    setAddress("");
    setStep(2);
  }

  function advance(event) {
    event.preventDefault();
    if (step === 3 && !channelAddress(platform, address)) {
      setMessage("地址与所选平台不匹配，请复制平台提供的完整 Webhook 地址。");
      return;
    }
    setMessage("");
    setStep(step + 1);
  }

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      const saved = await api("/notification-channels", "POST", { platform, name: name.trim(), url: address.trim() });
      onSaved(saved);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SideSheet title="添加其他来源" aria-label="添加其他来源" visible width="min(520px, 100vw)"
      onCancel={() => !saving && onClose()} closeOnEsc={!saving} maskClosable={!saving}
      maskStyle={{ background: "color-mix(in srgb, var(--ui-overlay) 16%, transparent)" }}
      className="channels-setup">
      <form className="channels-setup-form" onSubmit={step === 4 ? save : advance}>
        <div className="channels-setup-body">
          {otherPlatformSetupOpen && <ol className="channels-setup-steps" aria-label="接入步骤">
            {labels.map((label, index) => (
              <li key={label} aria-current={step === index + 1 ? "step" : undefined} data-complete={step > index + 1}>
                <span>{step > index + 1 ? <IconTickCircle aria-hidden="true" /> : index + 1}</span>{label}
              </li>
            ))}
          </ol>}
          {step === 1 && (
            <>
              <h2>{otherPlatformSetupOpen ? "选择要接入的平台" : "更多平台，敬请期待"}</h2>
              <p className="sc-muted">
                {otherPlatformSetupOpen ? "把 AJinOS 通知发到你选定的群或频道。" : "当前可在消息渠道首页接入飞书。"}
              </p>
              <div className="channels-platform-grid">
                {Object.entries(notificationPlatforms).map(([id, provider]) => (
                  <button type="button" key={id} disabled={!otherPlatformSetupOpen} onClick={() => choose(id, provider)}>
                    <strong>{provider.name}</strong>
                    <span>{otherPlatformSetupOpen ? `发到${provider.destination}` : "暂未开放"}</span>
                    {otherPlatformSetupOpen && <IconChevronRight size="small" aria-hidden="true" />}
                  </button>
                ))}
              </div>
              {otherPlatformSetupOpen && <button className="channels-setup-custom" type="button" onClick={onCustomSource}>
                <IconLink aria-hidden="true" />
                <span><strong>自定义 HTTP 来源</strong><small>从外部系统接收事件</small></span>
                <IconChevronRight size="small" aria-hidden="true" />
              </button>}
            </>
          )}
          {step === 2 && (
            <>
              <h2>准备{selected.name}连接</h2>
              <p className="sc-muted">此连接会向{selected.destination}发送通知。群消息读取需要另外接入。</p>
              <ol className="channels-setup-guide">
                {selected.steps.map((instruction) => <li key={instruction}>{instruction}</li>)}
              </ol>
            </>
          )}
          {step === 3 && (
            <>
              <h2>填写{selected.name}连接</h2>
              <label>
                连接名称
                <input className="channels-input" required maxLength={60} value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <label>
                Webhook 地址
                <input className="channels-input" type="password" autoComplete="off" spellCheck={false} required
                  maxLength={2048} value={address} placeholder="粘贴刚复制的完整地址"
                  onChange={(event) => { setAddress(event.target.value); setMessage(""); }} />
              </label>
              <p className="sc-muted">地址保存在本机私有配置中。</p>
            </>
          )}
          {step === 4 && (
            <>
              <h2>确认连接</h2>
              <dl className="channels-setup-review">
                <div><dt>连接</dt><dd>{name.trim()}</dd></div>
                <div><dt>用途</dt><dd>向{selected.destination}发送 AJinOS 通知</dd></div>
                <div><dt>生效</dt><dd>{snapshot.connected ? "保存后待重启引擎生效" : "启动本机引擎后生效"}</dd></div>
              </dl>
              <p className="sc-muted">未指定通知通道的规则也会将通知发到这个群或频道。</p>
            </>
          )}
          {message && <Banner type="danger" description={message} closeIcon={null} />}
        </div>
        {step > 1 && (
          <footer className="channels-setup-footer">
            <Button disabled={saving} onClick={() => { setMessage(""); setStep(step - 1); }}>上一步</Button>
            <Button theme="solid" htmlType="submit" loading={saving} disabled={step === 3 && (!address.trim() || !name.trim())}>
              {step === 4 ? "保存连接" : "下一步"}
            </Button>
          </footer>
        )}
      </form>
    </SideSheet>
  );
}
