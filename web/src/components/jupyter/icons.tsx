/** The icons of the workspace editor, after JupyterLab's (Material Design paths, the Jupyter mark, file-type icons). */

const PATHS = {
  folder: "M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z",
  add: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
  newFolder: "M20 6h-8l-2-2H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z",
  upload: "M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z",
  refresh: "M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
  save: "M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z",
  cut: "M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64zM6 8c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm0 12c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm6-7.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5zM19 3l-6 6 2 2 7-7V3z",
  copy: "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z",
  paste: "M19 2h-4.18C14.4.84 13.3 0 12 0c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 18H5V4h2v3h10V4h2v16z",
  run: "M8 5v14l11-7z",
  stop: "M6 6h12v12H6z",
  fastForward: "M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z",
  close: "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
  caretDown: "M7 10l5 5 5-5z",
  caretRight: "M10 17l5-5-5-5v10z",
  check: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  running: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4 14H8V8h8v8z",
  toc: "M3 9h14V7H3v2zm0 4h14v-2H3v2zm0 4h14v-2H3v2zm16 0h2v-2h-2v2zm0-10v2h2V7h-2zm0 6h2v-2h-2v2z",
  file: "M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z",
  moveUp: "M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z",
  moveDown: "M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z",
  addAbove: "M11 9h2v4h4v2h-4v4h-2v-4H7v-2h4V9zM4 3h16v2H4z",
  addBelow: "M11 5h2v4h4v2h-4v4h-2v-4H7V9h4V5zM4 19h16v2H4z",
  trash: "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
  cloud: "M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z",
  chip: "M15 9H9v6h6V9zm-2 4h-2v-2h2v2zm8-2V9h-2V7c0-1.1-.9-2-2-2h-2V3h-2v2h-2V3H9v2H7c-1.1 0-2 .9-2 2v2H3v2h2v2H3v2h2v2c0 1.1.9 2 2 2h2v2h2v-2h2v2h2v-2h2c1.1 0 2-.9 2-2v-2h2v-2h-2v-2h2zm-4 6H7V7h10v10z",
  computer: "M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z",
  download: "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z",
  edit: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
  database: "M12 3C7.58 3 4 4.79 4 7v10c0 2.21 3.59 4 8 4s8-1.79 8-4V7c0-2.21-3.58-4-8-4zm0 2c3.87 0 6 1.5 6 2s-2.13 2-6 2-6-1.5-6-2 2.13-2 6-2zm6 12c0 .5-2.13 2-6 2s-6-1.5-6-2v-2.23c1.61.78 3.72 1.23 6 1.23s4.39-.45 6-1.23V17zm0-4.55c-1.3.95-3.58 1.55-6 1.55s-4.7-.6-6-1.55V9.64c1.47.83 3.61 1.36 6 1.36s4.53-.53 6-1.36v2.81z",
  home: "M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z",
  ellipses: "M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z",
  back: "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z",
  cube: "M21 16.5c0 .38-.21.71-.53.88l-7.9 4.44c-.16.12-.36.18-.57.18-.21 0-.41-.06-.57-.18l-7.9-4.44A.991.991 0 0 1 3 16.5v-9c0-.38.21-.71.53-.88l7.9-4.44c.16-.12.36-.18.57-.18.21 0 .41.06.57.18l7.9 4.44c.32.17.53.5.53.88v9zM12 4.15L6.04 7.5 12 10.85l5.96-3.35L12 4.15zM5 15.91l6 3.38v-6.71L5 9.21v6.7zm14 0v-6.7l-6 3.37v6.71l6-3.38z",
  table: "M10 10.02h5V21h-5zM17 21h3c1.1 0 2-.9 2-2v-9h-5v11zm3-18H5c-1.1 0-2 .9-2 2v3h19V5c0-1.1-.9-2-2-2zM3 19c0 1.1.9 2 2 2h3V10H3v9z",
  keyboard: "M20 5H4c-1.1 0-1.99.9-1.99 2L2 17c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z",
  link: "M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z",
  git: "M21.62 11.11l-8.73-8.73a1.29 1.29 0 0 0-1.82 0L9.26 4.19l2.3 2.3a1.53 1.53 0 0 1 1.94 1.95l2.21 2.22a1.53 1.53 0 1 1-.92.86l-2.07-2.06v5.44a1.53 1.53 0 1 1-1.26-.05V9.36a1.53 1.53 0 0 1-.83-2.01L8.37 5.08 2.38 11.06a1.29 1.29 0 0 0 0 1.82l8.73 8.73a1.29 1.29 0 0 0 1.82 0l8.69-8.69a1.29 1.29 0 0 0 0-1.81z",
  diff: "M18 23H4c-1.1 0-2-.9-2-2V7h2v14h14v2zM15 1H8c-1.1 0-1.99.9-1.99 2L6 17c0 1.1.89 2 1.99 2H19c1.1 0 2-.9 2-2V7l-6-6zm1.5 14h-6v-2h6v2zm0-6h-2v2h-2V9h-2V7h2V5h2v2h2v2z",
  undo: "M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z",
  history: "M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z",
  terminal: "M20 4H4c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.89-2-2-2zm0 14H4V8h16v10zm-2-1h-6v-2h6v2zM7.5 17l-1.41-1.41L8.67 13l-2.59-2.59L7.5 9l4 4-4 4z",
  package: "M20.5 3.5L18.3 1H5.7L3.5 3.5H3v17.25c0 .69.56 1.25 1.25 1.25h15.5c.69 0 1.25-.56 1.25-1.25V3.5h-.5zM6.24 3h11.52l.83 1H5.42l.82-1zM19 20H5V6h14v14zm-6.6-7v-3h-2.8v3H7l5 5 5-5h-2.6z",
} as const;

export type IconName = keyof typeof PATHS | "jupyter" | "notebook" | "python" | "markdown" | "json" | "image";

export function JpIcon({ name, className = "jp-icon", title, style }: { name: IconName; className?: string; title?: string; style?: React.CSSProperties }) {
  if (name === "jupyter")
    return (
      <svg viewBox="0 0 38 44" className={className} style={{ fill: "none", ...style }} aria-hidden={!title}>
        {title && <title>{title}</title>}
        <circle cx="31.7" cy="3.6" r="2.6" fill="#767677" />
        <circle cx="5.2" cy="40" r="3.3" fill="#989798" />
        <circle cx="5.5" cy="5.8" r="1.9" fill="#6f7070" />
        <path fill="#f37726" d="M19 31.9c-7.4 0-13.9-2.7-17.3-6.6a18.5 18.5 0 0 0 34.6 0c-3.4 3.9-9.9 6.6-17.3 6.6zM19 9.8c7.4 0 13.9 2.7 17.3 6.6a18.5 18.5 0 0 0-34.6 0C5.1 12.5 11.6 9.8 19 9.8z" />
      </svg>
    );
  if (name === "notebook")
    return (
      <svg viewBox="0 0 22 22" className={className} style={{ fill: "#ef6c00", ...style }} aria-hidden={!title}>
        {title && <title>{title}</title>}
        <path d="M18.7 3.3v15.4H3.3V3.3h15.4m1.5-1.5H1.8v18.3h18.3V1.8z" />
        <path d="M16.5 16.5l-5.4-4.3-5.6 4.3v-11h11z" />
      </svg>
    );
  if (name === "python")
    return (
      <svg viewBox="0 0 24 24" className={className} style={style} aria-hidden={!title}>
        {title && <title>{title}</title>}
        <path fill="#0d47a1" d="M11.9 2c-5.1 0-4.8 2.2-4.8 2.2v2.3H12v.7H5.2S2 6.8 2 12s2.8 5 2.8 5h1.7v-2.4s-.1-2.8 2.8-2.8h4.7s2.7 0 2.7-2.6V4.8S17.1 2 11.9 2zM9.3 3.5c.5 0 .9.4.9.9s-.4.9-.9.9-.9-.4-.9-.9.4-.9.9-.9z" />
        <path fill="#ffc107" d="M12.1 22c5.1 0 4.8-2.2 4.8-2.2v-2.3H12v-.7h6.8S22 17.2 22 12s-2.8-5-2.8-5h-1.7v2.4s.1 2.8-2.8 2.8H10s-2.7 0-2.7 2.6v4.4S6.9 22 12.1 22zm2.6-1.5c-.5 0-.9-.4-.9-.9s.4-.9.9-.9.9.4.9.9-.4.9-.9.9z" />
      </svg>
    );
  if (name === "markdown")
    return (
      <svg viewBox="0 0 22 22" className={className} style={{ fill: "#7b1fa2", ...style }} aria-hidden={!title}>
        {title && <title>{title}</title>}
        <path d="M20.2 4.5H1.8C1.4 4.5 1 4.9 1 5.3v11.3c0 .5.4.8.8.8h18.3c.5 0 .8-.4.8-.8V5.3c.1-.4-.3-.8-.7-.8zM12.1 15H10V10.4l-1.8 2.3-1.8-2.3V15H4.3V7h2.1l1.8 2.3L10 7h2.1v8zm3.6.3L13 12h1.8V7h1.8v5h1.8l-2.7 3.3z" />
      </svg>
    );
  if (name === "json")
    return (
      <svg viewBox="0 0 22 22" className={className} style={{ fill: "#f9a825", ...style }} aria-hidden={!title}>
        {title && <title>{title}</title>}
        <path d="M7.4 4C6 4 5 5 5 6.4v2.4C5 10 4.3 10.4 3 10.4v1.2c1.3 0 2 .4 2 1.6v2.4C5 17 6 18 7.4 18H8v-1.6h-.6c-.6 0-.9-.4-.9-1V13c0-1.2-.6-1.8-1.5-2 .9-.2 1.5-.8 1.5-2V6.6c0-.6.3-1 .9-1H8V4h-.6zm7.2 0H14v1.6h.6c.6 0 .9.4.9 1V9c0 1.2.6 1.8 1.5 2-.9.2-1.5.8-1.5 2v2.4c0 .6-.3 1-.9 1H14V18h.6c1.4 0 2.4-1 2.4-2.4v-2.4c0-1.2.7-1.6 2-1.6v-1.2c-1.3 0-2-.4-2-1.6V6.4C17 5 16 4 14.6 4z" />
      </svg>
    );
  if (name === "image")
    return (
      <svg viewBox="0 0 22 22" className={className} style={{ fill: "#7b1fa2", ...style }} aria-hidden={!title}>
        {title && <title>{title}</title>}
        <path d="M2.2 2.2v17.6h17.6V2.2H2.2zm15.4 15.4H4.4V4.4h13.2v13.2zM12.4 11l-2.8 3.6-2-2.4-2.8 3.6h12.4l-4.8-4.8z" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} aria-hidden={!title}>
      {title && <title>{title}</title>}
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The file-type icon JupyterLab shows for a file. */
export function fileIcon(name: string, type: "directory" | "notebook" | "file"): IconName {
  if (type === "directory") return "folder";
  if (type === "notebook" || name.endsWith(".ipynb")) return "notebook";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "py") return "python";
  if (ext === "md") return "markdown";
  if (ext === "json") return "json";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return "image";
  if (["csv", "tsv", "parquet", "xlsx"].includes(ext)) return "table";
  return "file";
}
