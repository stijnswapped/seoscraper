import { useState, type FormEvent } from "react";

interface Props {
  loading: boolean;
  onSubmit: (url: string) => void;
}

export function UrlForm({ loading, onSubmit }: Props) {
  const [url, setUrl] = useState("");

  const handle = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (trimmed) onSubmit(trimmed);
  };

  return (
    <form className="url-form" onSubmit={handle}>
      <input
        type="url"
        placeholder="https://yourshop.example/products/black-linen-dress"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        disabled={loading}
        required
      />
      <button type="submit" disabled={loading}>
        {loading ? "Checking…" : "Check product"}
      </button>
    </form>
  );
}
