"use client";

import { useState, useRef } from "react";

interface UploadWidgetProps {
  onUploadComplete: () => void;
}

export default function UploadWidget({ onUploadComplete }: UploadWidgetProps) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleUpload(file: File) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("Only PDF files are supported");
      return;
    }

    setUploading(true);
    setError("");
    setProgress(0);

    try {
      // 1. Get presigned credentials
      const credRes = await fetch("/api/s3/credentials");
      if (!credRes.ok) throw new Error("Failed to get upload credentials");
      const { url, fields, projectPath } = await credRes.json();

      // 2. Upload directly to S3
      const formData = new FormData();
      Object.entries(fields).forEach(([k, v]) =>
        formData.append(k, v as string)
      );
      formData.append("file", file);

      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
      };

      await new Promise<void>((resolve, reject) => {
        xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error("Upload failed")));
        xhr.onerror = () => reject(new Error("Upload failed"));
        xhr.open("POST", url);
        xhr.send(formData);
      });

      // 3. Create project record
      const projectRes = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: file.name.replace(/\.pdf$/i, ""),
          dataUrl: projectPath,
        }),
      });

      if (!projectRes.ok) throw new Error("Failed to create project");

      onUploadComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      setProgress(0);
    }
  }

  return (
    <div>
      <input
        ref={fileRef}
        type="file"
        accept=".pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleUpload(file);
        }}
      />

      <button
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg hover:bg-[var(--accent-hover)] transition-colors text-sm font-medium disabled:opacity-50"
      >
        {uploading ? `Uploading ${progress}%` : "Upload PDF"}
      </button>

      {error && (
        <p className="text-red-400 text-sm mt-2">{error}</p>
      )}
    </div>
  );
}
