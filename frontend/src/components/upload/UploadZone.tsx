import { useRef, useState } from "react";

export default function UploadZone({ onFile }: { onFile: (f: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  return (
    <div
      className={"drop" + (drag ? " drag" : "")}
      onClick={() => input.current?.click()}
      onDragEnter={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setDrag(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
      }}
    >
      <div className="ico">♫</div>
      <div className="big">Drop a track or video to separate</div>
      <div className="small">
        audio (MP3 · WAV · FLAC · OGG · M4A) or video (MP4 · MOV · WEBM) — the video is kept
        as a project asset&nbsp;&nbsp;(drag &amp; drop or click)
      </div>
      <input
        ref={input}
        type="file"
        accept="audio/*,video/*"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) onFile(e.target.files[0]);
        }}
      />
    </div>
  );
}
