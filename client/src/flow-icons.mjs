// Small native illustrations share the approved canvas palette and remain sharp at desktop zoom levels.
let sequence = 0;
export function flowIcon(kind) {
  const id = `fi-${++sequence}`;
  const drawings = {
    chat: `<path d="M8 12h29a6 6 0 0 1 6 6v17a6 6 0 0 1-6 6H22l-9 7v-7H8a6 6 0 0 1-6-6V18a6 6 0 0 1 6-6Z" fill="url(#${id}-blue)"/><g fill="white"><circle cx="13" cy="26" r="2.1"/><circle cx="22" cy="26" r="2.1"/><circle cx="31" cy="26" r="2.1"/></g>`,
    gateway: `<path d="m4 30 20-8 20 8v12l-20 8L4 42Z" fill="#e5e8e3"/><path d="m4 30 20 8 20-8-20-8Z" fill="#fffefb"/><g stroke="#b2b8b6" stroke-width="3.5" stroke-linecap="round"><path d="M12 29V14M24 25V8M36 29V17"/></g><g fill="#8bb675"><circle cx="12" cy="38" r="1.7"/><circle cx="18" cy="40" r="1.7"/></g>`,
    stack: `<path d="m4 31 20-10 20 10v5L24 47 4 37Z" fill="#8a7af1"/><path d="m4 22 20-10 20 10v6L24 39 4 29Z" fill="#ac9ff7"/><path d="M4 22 24 11l20 11-20 11Z" fill="#d4ccff"/><path d="m4 14 20-10 20 10v5L24 30 4 20Z" fill="#a99af9"/><path d="M4 14 24 3l20 11-20 10Z" fill="#e1dbff"/>`,
    palette: `<path d="M26 5C12 3 3 15 4 28c1 13 13 20 24 15 5-2-6-7-2-11 3-4 13 1 17-7C49 13 38 5 26 5Z" fill="#f2e9ca"/><circle cx="16" cy="15" r="4" fill="#84af95"/><circle cx="29" cy="13" r="3.5" fill="#b4bf83"/><circle cx="37" cy="22" r="3.3" fill="#c4a479"/><circle cx="12" cy="27" r="3.4" fill="#e2bf8a"/>`,
    document: `<rect x="9" y="4" width="31" height="43" rx="6" fill="#e5e1fa"/><rect x="6" y="2" width="31" height="41" rx="6" fill="#f5f3ff"/><g stroke="#a49aee" stroke-width="3" stroke-linecap="round"><path d="M16 14h14M16 23h14M16 32h10"/></g><g fill="#8474db"><circle cx="11" cy="14" r="1.5"/><circle cx="11" cy="23" r="1.5"/><circle cx="11" cy="32" r="1.5"/></g>`,
    model: `<g fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"><path d="M24 7c10-7 22 5 16 14 9 10-1 24-12 20-11 9-25-1-21-12C-1 17 10 5 20 10Z"/><path d="m20 10 15 9v15l-15 8M40 21l-16-9-13 8v16M7 29l17 10 13-8V17M15 18v14l13 7M20 11l14 8v15M12 23l12-7 12 7-1 11-11 7"/></g>`,
    queue: `<path d="m5 33 19-9 19 9v6l-19 10-19-10Z" fill="#e9af5a"/><path d="m5 23 19-9 19 9v6l-19 10-19-10Z" fill="#f7ca7d"/><path d="m5 14 19-9 19 9v6L24 30 5 20Z" fill="#ffe0a1"/><path d="m5 14 19 9 19-9-19-9Z" fill="#ffecc6"/>`,
    play: `<circle cx="24" cy="26" r="20" fill="url(#${id}-violet)"/><path d="m20 15 14 10-14 10Z" fill="white" stroke="#f8f6ff" stroke-width="2" stroke-linejoin="round"/>`,
    check: `<circle cx="24" cy="25" r="19" fill="url(#${id}-green)"/><path d="m14 25 7 7 13-15" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
    reply: `<path d="M41 23c0 12-12 20-24 16L7 44l2-11C-3 16 13 1 28 7c8 2 13 8 13 16Z" fill="none" stroke="#656775" stroke-width="2.8"/><g fill="#656775"><circle cx="15" cy="23" r="2"/><circle cx="23" cy="23" r="2"/><circle cx="31" cy="23" r="2"/></g>`,
  };
  return `<span class="fc-icon fc-icon-${kind}" aria-hidden="true"><svg viewBox="0 0 48 52"><defs><linearGradient id="${id}-blue" x2="0" y2="1"><stop stop-color="#bce2ff"/><stop offset="1" stop-color="#5087f7"/></linearGradient><linearGradient id="${id}-violet" x2="1" y2="1"><stop stop-color="#e7ddff"/><stop offset="1" stop-color="#8971ed"/></linearGradient><linearGradient id="${id}-green" x2="1" y2="1"><stop stop-color="#b0daa4"/><stop offset="1" stop-color="#6bad65"/></linearGradient></defs>${drawings[kind] || drawings.document}</svg></span>`;
}
