import type { SVGProps } from "react";

const paths = {
  panel: "M9 3v18M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z",
  plus: "M12 5v14M5 12h14",
  folder: "M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z",
  chat: "M21 11a9 9 0 0 1-9 9H5l-3 2 1-6A9 9 0 1 1 21 11ZM8 10h8M8 14h5",
  terminal: "m5 6 5 6-5 6M13 18h6",
  changes: "M8 3v12a4 4 0 0 0 4 4h4M16 5v14M5 3h6M13 5h6M13 19h6",
  settings: "M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6",
  chevron: "m9 6 6 6-6 6",
  code: "m8 5-6 7 6 7M16 5l6 7-6 7M14 3l-4 18",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6",
  arrow: "M12 19V5m-6 6 6-6 6 6",
  spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z",
  close: "m6 6 12 12M18 6 6 18",
  edit: "m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14v6Z",
  archive: "M3 3h18v5H3V3Zm2 5v13h14V8M9 12h6",
  restore: "M4 10a8 8 0 1 1 1 8M4 4v6h6M12 7v5l3 2",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
} as const;

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: keyof typeof paths }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.65"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}><path d={paths[name]} /></svg>;
}
