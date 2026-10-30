export function Icon({ name, size = 19 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    cloud: 'M7 18a5 5 0 1 1 1-10 6 6 0 0 1 11 3 4 4 0 0 1 0 8H7z',
    plus: 'M12 5v14M5 12h14',
    search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    folder: 'M3 5h6l2 3h10v12H3z',
    chat: 'M4 4h16v13H9l-5 4z',
    settings:
      'M9.8 3h4.4l.5 2.3 1.5.9 2.3-.7 2.2 3.8-1.7 1.6v2.2l1.7 1.6-2.2 3.8-2.3-.7-1.5.9-.5 2.3H9.8l-.5-2.3-1.5-.9-2.3.7-2.2-3.8L5 13.1v-2.2L3.3 9.3l2.2-3.8 2.3.7 1.5-.9zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    terminal: 'm4 5 6 7-6 7M12 19h8',
    arrow: 'M12 20V4m-6 6 6-6 6 6',
    attach: 'm8 12 7-7a4 4 0 0 1 6 6L10 22a6 6 0 0 1-8-8L13 3',
    menu: 'M4 5h16M4 12h16M4 19h16',
    archive: 'M3 3h18v5H3zM5 8v13h14V8M9 12h6',
    sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2M12 20v2M2 12h2M20 12h2',
    close: 'm5 5 14 14M19 5 5 19',
    check: 'm4 12 5 5L20 6',
    copy: 'M9 9h12v12H9zM5 15H3V3h12v2',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    refresh: 'M20 7A9 9 0 1 0 21 14M20 2v5h-5',
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.chat} />
    </svg>
  );
}
