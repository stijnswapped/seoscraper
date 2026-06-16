// Small reusable "copy to clipboard" button with a transient confirmation.

import { useState } from "react";

export function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied!",
  className = "btn",
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      /* clipboard blocked — ignore */
    }
  };

  return (
    <button type="button" className={className} onClick={onCopy} aria-live="polite">
      {copied ? copiedLabel : label}
    </button>
  );
}
