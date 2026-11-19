// The editor's icons: small inline SVGs drawn in the text colour, so they follow
// every theme. No icon font and nothing fetched.
const svg = (body: string, fill = false) =>
  `<svg class="icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="${fill ? 'currentColor' : 'none'}" stroke="${fill ? 'none' : 'currentColor'}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const icons = {
  logo: `<svg class="logo" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><rect width="24" height="24" rx="6" fill="currentColor"/><path d="M4.5 15.5c2.5 0 3-7 7.5-7s5 7 7.5 7" fill="none" stroke="var(--accent-ink)" stroke-width="2" stroke-linecap="round"/><circle cx="4.5" cy="15.5" r="1.6" fill="var(--accent-ink)"/><circle cx="19.5" cy="15.5" r="1.6" fill="var(--accent-ink)"/></svg>`,
  play: svg('<path d="M7.5 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L8.7 4.5a.8.8 0 0 0-1.2.7z"/>', true),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>', true),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  save: svg('<path d="M5 3h11l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M8 3v5h7V3"/><path d="M7.5 21v-6.5h9V21"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  fit: svg('<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>'),
  grid: svg('<circle cx="6" cy="6" r="1.5"/><circle cx="12" cy="6" r="1.5"/><circle cx="18" cy="6" r="1.5"/><circle cx="6" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18" cy="12" r="1.5"/><circle cx="6" cy="18" r="1.5"/><circle cx="12" cy="18" r="1.5"/><circle cx="18" cy="18" r="1.5"/>', true),
  map: svg('<path d="M9 4 3.8 5.9a1 1 0 0 0-.8 1v11.6a.6.6 0 0 0 .8.6L9 17l6 3 5.2-1.9a1 1 0 0 0 .8-1V5.5a.6.6 0 0 0-.8-.6L15 7z"/><path d="M9 4v13M15 7v13"/>'),
  guide: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'),
  panels: svg('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 14.5h18"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>'),
  warn: svg('<path d="M10.3 4.2 2.7 17.5A2 2 0 0 0 4.4 20.5h15.2a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
};
