import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Mounts children into a dedicated DOM node appended to document.body —
 * OUTSIDE the React app root — so the print/PDF sheet survives `#root`
 * being hidden wholesale under @media print (see style.css's `.print-stage`
 * / `#root` rules). `display:none` on an ancestor removes its ENTIRE
 * subtree from rendering with no way for a descendant to opt back in
 * (unlike `visibility`), so the only way to keep this content alive while
 * `#root` disappears is to not be a descendant of it at all.
 */
export function PrintPortal({ children }: { children: ReactNode }) {
  const [node] = useState(() => document.createElement("div"));

  useEffect(() => {
    document.body.appendChild(node);
    return () => {
      document.body.removeChild(node);
    };
  }, [node]);

  return createPortal(children, node);
}
