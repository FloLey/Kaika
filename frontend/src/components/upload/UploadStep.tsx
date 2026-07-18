import { useRef, useState } from "react";
import UploadZone from "./UploadZone";

// Step 1 — pick an audio file and (optionally) paste or attach its lyrics.
// Lyrics drive the segment proposal; without them we fall back to vocal
// activity + timbre clustering.
interface UploadSubmit {
  file: File | null;
  youtubeUrl: string;
  ytStart: string;
  ytEnd: string;
  lyrics: string;
  lyricsFile: File | null;
}

export default function UploadStep({ onSubmit }: { onSubmit: (data: UploadSubmit) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [ytStart, setYtStart] = useState("");
  const [ytEnd, setYtEnd] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [lyricsFile, setLyricsFile] = useState<File | null>(null);
  const lyricsInput = useRef<HTMLInputElement>(null);

  function pickLyricsFile(f: File) {
    setLyricsFile(f);
    const reader = new FileReader();
    reader.onload = () => setLyrics(String(reader.result || ""));
    reader.readAsText(f);
  }

  return (
    <div className="step upload-step">
      {!file ? (
        <>
          <UploadZone onFile={setFile} />
          <div className="or-sep">
            <span>or</span>
          </div>
          <div className="yt-box">
            <span className="yt-ico">▶</span>
            <input
              className="yt-input"
              type="url"
              inputMode="url"
              placeholder="Paste a YouTube URL (best audio is downloaded)"
              value={youtubeUrl}
              onChange={(e) => setYoutubeUrl(e.target.value)}
            />
          </div>
          {youtubeUrl.trim() && (
            <div className="yt-range">
              <span className="yt-range-label"
                title="Only this part of the video is downloaded (not the whole file). Leave empty for the full track.">
                clip (optional)
              </span>
              <input
                className="yt-range-input"
                placeholder="start 0:00"
                value={ytStart}
                onChange={(e) => setYtStart(e.target.value)}
              />
              <span className="yt-range-sep">→</span>
              <input
                className="yt-range-input"
                placeholder="end 3:45"
                value={ytEnd}
                onChange={(e) => setYtEnd(e.target.value)}
              />
            </div>
          )}
        </>
      ) : (
        <div className="picked">
          <div className="ico">♫</div>
          <div className="big">{file.name}</div>
          <button className="btn sm" onClick={() => setFile(null)}>
            ↩ choose another file
          </button>
        </div>
      )}

      <div className="lyrics-box">
        <div className="lyrics-head">
          <span className="section-title">LYRICS (optional)</span>
          <div className="controls">
            <button className="btn sm" onClick={() => lyricsInput.current?.click()}>
              ⇪ load .txt / .lrc
            </button>
            {lyricsFile && <span className="time">{lyricsFile.name}</span>}
            <input
              ref={lyricsInput}
              type="file"
              accept=".txt,.lrc,text/plain"
              hidden
              onChange={(e) => {
                if (e.target.files?.[0]) pickLyricsFile(e.target.files[0]);
              }}
            />
          </div>
        </div>
        <textarea
          className="lyrics-area"
          placeholder="Paste the song lyrics here (one line per lyric line). Leave empty for an instrumental — we'll segment from vocal activity instead."
          value={lyrics}
          onChange={(e) => {
            setLyrics(e.target.value);
            setLyricsFile(null);
          }}
          rows={10}
        />
      </div>

      <div className="step-actions">
        <button
          className="btn"
          disabled={!file && !youtubeUrl.trim()}
          onClick={() =>
            onSubmit({
              file,
              youtubeUrl: youtubeUrl.trim(),
              ytStart: ytStart.trim(),
              ytEnd: ytEnd.trim(),
              lyrics,
              lyricsFile,
            })
          }
        >
          ▶ separate &amp; propose segments
        </button>
      </div>
    </div>
  );
}
