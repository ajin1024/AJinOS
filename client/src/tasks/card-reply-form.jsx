import React from "react";
import { Button, Tag } from "@douyinfe/semi-ui";

export function CardReplyForm({
  card,
  draft = { choice: "", text: "" },
  submitting = false,
  connected = true,
  showTitle = true,
  onDraftChange,
  onSubmit,
}) {
  const ask = card.kind === "ask";
  const options = [...(card.options || []), "其他回答"];
  const choice = draft.choice ?? "";
  const text = draft.text ?? "";
  const showTextarea = !ask || choice === "text";

  function handleSubmit(event) {
    event.preventDefault();
    onSubmit(card, { choice, text });
  }

  return (
    <form className="pending-reply tc-card-form" data-card-id={card.id} onSubmit={handleSubmit}>
      <fieldset disabled={submitting || !connected}>
        {showTitle && (
          <div className="tc-card-head">
            <legend>{card.title}</legend>
            <Tag color={ask ? "amber" : "cyan"} shape="circle">
              {ask ? "待你决定" : "待处理通知"}
            </Tag>
          </div>
        )}
        {card.text && <p className="tc-card-text">{card.text}</p>}
        {ask && (
          <div className="pending-options" role="group" aria-label="答复选项">
            {options.map((option, i) => {
              const value = i === options.length - 1 ? "text" : String(i);
              return (
                <label key={value} className={choice === value ? "is-selected" : ""}>
                  <input
                    type="radio"
                    id={`reply-${card.id}-${value}`}
                    name={`choice-${card.id}`}
                    value={value}
                    checked={choice === value}
                    required
                    onChange={() => onDraftChange(String(card.id), { choice: value, text })}
                  />
                  <span>{option}</span>
                  {i === card.recommend && <small>建议</small>}
                </label>
              );
            })}
          </div>
        )}
        <label className="pending-text" hidden={!showTextarea}>
          {ask ? "你的回答" : "处理说明"}
          <textarea
            id={`reply-${card.id}-message`}
            name="text"
            rows={3}
            required={showTextarea}
            value={text}
            placeholder={ask ? "输入你的决定或补充说明…" : "记录处理情况…"}
            onChange={(e) => onDraftChange(String(card.id), { choice, text: e.target.value })}
          />
        </label>
        <div className="pending-submit">
          <Button
            theme="solid"
            htmlType="submit"
            id={`reply-${card.id}-submit`}
            loading={submitting}
            disabled={submitting || !connected}
          >
            {submitting ? "正在提交…" : ask ? "提交答复" : "标记已处理"}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
