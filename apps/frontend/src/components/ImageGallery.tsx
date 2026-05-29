import { API_BASE, type DownloadedImage } from "../api.js";

interface Props {
  images: DownloadedImage[];
  fileBaseUrl: string;
}

export function ImageGallery({ images, fileBaseUrl }: Props) {
  if (images.length === 0) {
    return <p>No images were downloaded.</p>;
  }
  return (
    <div className="gallery">
      {images.map((img) => (
        <figure key={img.filePath}>
          <img
            src={`${API_BASE}${fileBaseUrl}/${img.filePath}`}
            alt={img.filename}
            loading="lazy"
          />
          <figcaption>
            <strong>{img.filename}</strong>
            <div style={{ marginTop: "0.2rem", opacity: 0.8 }}>
              {img.width && img.height ? `${img.width}×${img.height}` : ""}
              {img.groupId ? ` · Group: ${img.groupId}` : ""}
            </div>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
