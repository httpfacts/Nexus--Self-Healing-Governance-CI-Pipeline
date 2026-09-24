import { FolderIcon } from "./Icons.jsx";

// Turns "a/b/c.py" into a dimmed folder trail + a highlighted filename,
// instead of one flat monospace string -- makes it obvious at a glance
// which part of the repo a change (or a control-plane match) lives in.
export default function FilePathBreadcrumb({ path }) {
  const parts = path.split("/");
  const file = parts.pop();
  return (
    <span className="file-breadcrumb">
      {parts.length > 0 && (
        <span className="file-breadcrumb-dirs">
          <FolderIcon width="12" height="12" />
          {parts.map((seg, i) => (
            <span key={i}>
              {seg}
              <span className="file-breadcrumb-sep">/</span>
            </span>
          ))}
        </span>
      )}
      <span className="file-breadcrumb-name">{file}</span>
    </span>
  );
}
