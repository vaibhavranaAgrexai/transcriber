import { useState, useRef, useCallback, useEffect } from "react";

const PROVIDERS = {
  groq: {
    name: "Groq",
    badge: "FREE",
    badgeColor: "#10B981",
    url: "https://api.groq.com/openai/v1/audio/transcriptions",
    model: "whisper-large-v3",
    hint: "Get free key → console.groq.com",
    hintUrl: "https://console.groq.com"
  },
  openai: {
    name: "OpenAI",
    badge: "$0.006/min",
    badgeColor: "#F59E0B",
    url: "https://api.openai.com/v1/audio/transcriptions",
    model: "whisper-1",
    hint: "Get key → platform.openai.com",
    hintUrl: "https://platform.openai.com"
  }
};

const MODES = [
  {
    id: "screen",
    icon: "\u2B1C",
    label: "Screen / Tab Audio",
    desc: "Captures all participants \u2014 Chrome desktop only",
    tip: "When prompted, select your meeting tab and check 'Share tab audio'"
  },
  {
    id: "mic",
    icon: "\u25CE",
    label: "Microphone Only",
    desc: "Your voice only \u2014 works on iPad & mobile",
    tip: null
  },
  {
    id: "file",
    icon: "\u2191",
    label: "Upload Recording",
    desc: "Any audio or video file (mp3, mp4, m4a, webm\u2026)",
    tip: null
  }
];

function fmt(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
  return `${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
}

function fmtBytes(b) {
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export default function App() {
  const [provider, setProvider] = useState(() => localStorage.getItem("transcriber_provider") || "groq");
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("transcriber_apiKey") || "");
  const [mode, setMode] = useState("screen");
  const [phase, setPhase] = useState("setup");
  const [secs, setSecs] = useState(0);
  const [fileSize, setFileSize] = useState(0);
  const [bars, setBars] = useState(new Array(32).fill(3));
  const [transcript, setTranscript] = useState("");
  const [wordCount, setWordCount] = useState(0);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [processingMsg, setProcessingMsg] = useState("Sending to Whisper\u2026");

  useEffect(() => { localStorage.setItem("transcriber_provider", provider); }, [provider]);
  useEffect(() => { localStorage.setItem("transcriber_apiKey", apiKey); }, [apiKey]);

  const recRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);
  const mimeRef = useRef("audio/webm");
  const sizeRef = useRef(0);

  const startWaveform = useCallback((stream) => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 128;
      src.connect(an);
      analyserRef.current = an;
      const tick = () => {
        const d = new Uint8Array(an.frequencyBinCount);
        an.getByteFrequencyData(d);
        const step = Math.max(1, Math.floor(d.length / 32));
        setBars(new Array(32).fill(0).map((_, i) => {
          const v = (d[Math.min(i * step, d.length - 1)] || 0) / 255;
          return Math.max(3, Math.round(v * 56));
        }));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (_) {}
  }, []);

  const stopWaveform = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setBars(new Array(32).fill(3));
  }, []);

  const doTranscribe = useCallback(async (blob) => {
    setPhase("processing");
    setProcessingMsg("Sending to Whisper\u2026");
    setError("");

    try {
      if (blob.size > 24.5 * 1024 * 1024) {
        throw new Error(
          `Recording is ${fmtBytes(blob.size)} \u2014 Whisper's limit is 25 MB. ` +
          "For longer meetings, use 'Microphone Only' mode (smaller files) or split into parts."
        );
      }

      const { url, model } = PROVIDERS[provider];
      const ext = mimeRef.current.includes("ogg") ? "ogg"
        : mimeRef.current.includes("mp4") ? "mp4" : "webm";

      const fd = new FormData();
      fd.append("file", blob, `meeting.${ext}`);
      fd.append("model", model);
      fd.append("response_format", "json");
      fd.append("language", "en");

      setProcessingMsg(`Transcribing ${fmtBytes(blob.size)} with ${PROVIDERS[provider].name}\u2026`);
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
        body: fd
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || `API error ${res.status}`);

      const text = data.text?.trim() || "No speech detected.";
      setTranscript(text);
      setWordCount(text.split(/\s+/).filter(Boolean).length);
      setPhase("done");
    } catch (err) {
      setError(err.message);
      setPhase("setup");
    }
  }, [provider, apiKey]);

  const startRecording = async () => {
    if (!apiKey.trim()) { setError("Enter your API key first."); return; }
    setError("");
    chunksRef.current = [];
    sizeRef.current = 0;

    try {
      if (!navigator.mediaDevices) {
        setError("Microphone access requires HTTPS or localhost. Open this page via localhost instead of an IP address.");
        return;
      }
      let stream;
      if (mode === "screen") {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: true });
        if (stream.getAudioTracks().length === 0) {
          stream.getTracks().forEach(t => t.stop());
          setError("No audio captured. When Chrome asks what to share, select your meeting tab and tick 'Share tab audio'.");
          return;
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }

      streamRef.current = stream;
      const audioStream = new MediaStream(stream.getAudioTracks());
      startWaveform(audioStream);

      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"]
        .find(t => MediaRecorder.isTypeSupported(t)) || "";
      mimeRef.current = mime || "audio/webm";

      const rec = new MediaRecorder(audioStream, mime ? { mimeType: mime } : {});
      rec.ondataavailable = e => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
          sizeRef.current += e.data.size;
          setFileSize(sizeRef.current);
        }
      };

      stream.getVideoTracks().forEach(t => { t.onended = () => handleStop(); });

      rec.start(800);
      recRef.current = rec;
      setSecs(0);
      setFileSize(0);
      setPhase("recording");
      timerRef.current = setInterval(() => setSecs(s => s + 1), 1000);

    } catch (err) {
      if (err.name === "NotAllowedError") setError("Permission denied \u2014 please allow access and try again.");
      else setError(err.message);
    }
  };

  const handleStop = useCallback(async () => {
    clearInterval(timerRef.current);
    stopWaveform();

    if (recRef.current?.state !== "inactive") recRef.current.stop();
    streamRef.current?.getTracks().forEach(t => t.stop());

    await new Promise(r => setTimeout(r, 700));
    const blob = new Blob(chunksRef.current, { type: mimeRef.current });
    doTranscribe(blob);
  }, [stopWaveform, doTranscribe]);

  const handleFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!apiKey.trim()) { setError("Enter your API key first."); return; }
    mimeRef.current = f.type;
    doTranscribe(f);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(transcript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([transcript], { type: "text/plain" }));
    a.download = `transcript-${new Date().toISOString().slice(0, 16).replace("T", "-")}.txt`;
    a.click();
  };

  const reset = () => { setPhase("setup"); setTranscript(""); setError(""); setSecs(0); setFileSize(0); };

  const prov = PROVIDERS[provider];
  const overLimit = fileSize > 22 * 1024 * 1024;

  const S = {
    root: {
      minHeight: "100vh", background: "#070810",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      color: "#E2E8F0", padding: "24px 16px"
    },
    card: { width: "100%", maxWidth: "500px" },
    label: { fontSize: "10px", letterSpacing: "0.14em", color: "#6366F1", textTransform: "uppercase", fontWeight: 700 },
    muted: { fontSize: "12px", color: "#475569" },
    input: {
      display: "block", width: "100%", boxSizing: "border-box",
      marginTop: "8px", background: "#0E1020", border: "1px solid #1E2540",
      borderRadius: "8px", padding: "10px 14px", color: "#E2E8F0",
      fontSize: "14px", outline: "none", fontFamily: "inherit"
    }
  };

  return (
    <div style={S.root}>
      <div style={S.card}>

        <div style={{ textAlign: "center", marginBottom: "28px" }}>
          <div style={S.label}>AI Meeting Transcriber</div>
          <h1 style={{ fontSize: "26px", fontWeight: 700, margin: "8px 0 0", color: "#F8FAFC" }}>
            {phase === "setup" && "One-click transcript"}
            {phase === "recording" && "Recording\u2026"}
            {phase === "processing" && "Transcribing\u2026"}
            {phase === "done" && "Your transcript"}
          </h1>
        </div>

        {phase === "setup" && (
          <>
            <div style={{ marginBottom: "20px" }}>
              <div style={S.label}>Engine</div>
              <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                {Object.entries(PROVIDERS).map(([k, p]) => (
                  <button key={k} onClick={() => setProvider(k)} style={{
                    flex: 1, padding: "10px 12px", borderRadius: "8px",
                    cursor: "pointer", fontFamily: "inherit",
                    background: provider === k ? "#1E2050" : "#0E1020",
                    border: `1px solid ${provider === k ? "#6366F1" : "#1E2540"}`,
                    color: provider === k ? "#C7D2FE" : "#64748B",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: "8px"
                  }}>
                    <span style={{ fontSize: "14px", fontWeight: 700 }}>{p.name}</span>
                    <span style={{
                      fontSize: "10px", fontWeight: 700, padding: "2px 6px",
                      borderRadius: "4px", background: p.badgeColor + "22", color: p.badgeColor
                    }}>{p.badge}</span>
                  </button>
                ))}
              </div>
              <div style={{ marginTop: "6px", ...S.muted }}>{prov.hint}</div>
            </div>

            <div style={{ marginBottom: "20px" }}>
              <div style={S.label}>API Key</div>
              <div style={{ position: "relative" }}>
                <input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder={`${prov.name} API key`}
                  style={S.input}
                />
                <button onClick={() => setShowKey(v => !v)} style={{
                  position: "absolute", right: "10px", top: "50%", transform: "translateY(-50%)",
                  background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: "12px"
                }}>{showKey ? "hide" : "show"}</button>
              </div>
            </div>

            <div style={{ marginBottom: "24px" }}>
              <div style={S.label}>Audio Source</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "8px" }}>
                {MODES.map(m => (
                  <button key={m.id} onClick={() => setMode(m.id)} style={{
                    display: "flex", alignItems: "center", gap: "14px",
                    padding: "12px 14px", borderRadius: "9px", cursor: "pointer",
                    border: `1px solid ${mode === m.id ? "#6366F1" : "#1E2540"}`,
                    background: mode === m.id ? "#0D0F2A" : "#0E1020",
                    textAlign: "left", fontFamily: "inherit"
                  }}>
                    <span style={{
                      width: "32px", height: "32px", borderRadius: "8px", flexShrink: 0,
                      background: mode === m.id ? "#6366F133" : "#1E2540",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: "16px", color: mode === m.id ? "#818CF8" : "#475569"
                    }}>{m.icon}</span>
                    <div>
                      <div style={{ fontSize: "13px", fontWeight: 600, color: mode === m.id ? "#A5B4FC" : "#CBD5E1" }}>
                        {m.label}
                      </div>
                      <div style={{ fontSize: "11px", color: "#475569", marginTop: "2px" }}>{m.desc}</div>
                    </div>
                  </button>
                ))}
              </div>
              {MODES.find(m => m.id === mode)?.tip && (
                <div style={{ marginTop: "8px", padding: "8px 12px", borderRadius: "6px", background: "#0E1020", border: "1px solid #1E2540" }}>
                  <span style={{ fontSize: "11px", color: "#6366F1", fontWeight: 700 }}>TIP  </span>
                  <span style={{ fontSize: "11px", color: "#64748B" }}>{MODES.find(m2 => m2.id === mode)?.tip}</span>
                </div>
              )}
            </div>

            {error && (
              <div style={{
                background: "#1A0A10", border: "1px solid #F43F5E44",
                borderRadius: "8px", padding: "10px 14px", marginBottom: "16px"
              }}>
                <span style={{ fontSize: "13px", color: "#FDA4AF" }}>{error}</span>
              </div>
            )}

            {mode === "file" ? (
              <label style={{
                display: "block", padding: "14px", borderRadius: "10px",
                background: "linear-gradient(135deg, #6366F1, #818CF8)",
                color: "#fff", textAlign: "center", fontSize: "15px",
                fontWeight: 700, cursor: "pointer",
                boxShadow: "0 4px 20px #6366F140"
              }}>
                \u2191 Choose Audio / Video File
                <input type="file" accept="audio/*,video/*" onChange={handleFile} style={{ display: "none" }} />
              </label>
            ) : (
              <button onClick={startRecording} style={{
                width: "100%", padding: "14px", borderRadius: "10px", border: "none",
                background: "linear-gradient(135deg, #6366F1, #818CF8)",
                color: "#fff", fontSize: "15px", fontWeight: 700, cursor: "pointer",
                boxShadow: "0 4px 20px #6366F140", fontFamily: "inherit"
              }}>
                \u25CF Start Recording
              </button>
            )}
          </>
        )}

        {phase === "recording" && (
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", marginBottom: "20px" }}>
              <div style={{
                width: "10px", height: "10px", borderRadius: "50%", background: "#F43F5E",
                animation: "pulse 1.2s ease-in-out infinite"
              }} />
              <span style={{ fontSize: "12px", color: "#64748B", letterSpacing: "0.1em", textTransform: "uppercase" }}>
                Live recording
              </span>
            </div>
            <style>{`
              @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.4;transform:scale(0.8)} }
              @keyframes spin { to{transform:rotate(360deg)} }
            `}</style>

            <div style={{
              fontSize: "72px", fontWeight: 800, letterSpacing: "0.04em",
              fontFamily: "ui-monospace, 'SF Mono', monospace", color: "#F8FAFC",
              marginBottom: "8px", lineHeight: 1
            }}>
              {fmt(secs)}
            </div>

            <div style={{ fontSize: "12px", color: overLimit ? "#F87171" : "#475569", marginBottom: "24px" }}>
              {fmtBytes(fileSize)} recorded
              {overLimit && " \u2014 approaching 25 MB limit, stop soon"}
            </div>

            <div style={{
              display: "flex", alignItems: "flex-end", justifyContent: "center",
              gap: "2.5px", height: "60px", marginBottom: "32px", padding: "0 8px"
            }}>
              {bars.map((h, i) => (
                <div key={i} style={{
                  width: "6px", height: `${h}px`, borderRadius: "3px",
                  background: `hsl(${230 + (i / 32) * 40}, 75%, ${55 + (h / 56) * 25}%)`,
                  transition: "height 0.08s ease", flexShrink: 0
                }} />
              ))}
            </div>

            <button onClick={handleStop} style={{
              padding: "14px 48px", borderRadius: "10px", border: "none",
              background: "#F43F5E", color: "#fff", fontSize: "15px",
              fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
              boxShadow: "0 4px 20px #F43F5E44"
            }}>
              \u25A0 Stop & Transcribe
            </button>
          </div>
        )}

        {phase === "processing" && (
          <div style={{ textAlign: "center", padding: "48px 0" }}>
            <div style={{
              width: "52px", height: "52px", margin: "0 auto 20px",
              borderRadius: "50%", border: "3px solid #1E2540",
              borderTopColor: "#6366F1", animation: "spin 0.9s linear infinite"
            }} />
            <div style={{ fontSize: "16px", color: "#94A3B8", fontWeight: 500 }}>
              {processingMsg}
            </div>
            <div style={{ fontSize: "12px", color: "#334155", marginTop: "8px" }}>
              Whisper handles Indian English & Hinglish well \u2014 be patient with long recordings
            </div>
          </div>
        )}

        {phase === "done" && (
          <>
            <div style={{ display: "flex", gap: "12px", marginBottom: "16px" }}>
              {[
                { label: "Words", value: wordCount.toLocaleString() },
                { label: "Duration", value: fmt(secs) },
                { label: "Engine", value: prov.name }
              ].map(stat => (
                <div key={stat.label} style={{
                  flex: 1, background: "#0E1020", border: "1px solid #1E2540",
                  borderRadius: "8px", padding: "10px 12px", textAlign: "center"
                }}>
                  <div style={{ fontSize: "18px", fontWeight: 700, color: "#A5B4FC" }}>{stat.value}</div>
                  <div style={{ fontSize: "10px", color: "#475569", textTransform: "uppercase", letterSpacing: "0.08em" }}>{stat.label}</div>
                </div>
              ))}
            </div>

            <div style={{
              background: "#0A0C1A", border: "1px solid #1E2540", borderRadius: "10px",
              padding: "16px", maxHeight: "340px", overflowY: "auto", marginBottom: "14px"
            }}>
              <p style={{
                margin: 0, fontSize: "14px", lineHeight: 1.75,
                color: "#CBD5E1", whiteSpace: "pre-wrap"
              }}>
                {transcript}
              </p>
            </div>

            <div style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
              <button onClick={handleCopy} style={{
                flex: 1, padding: "11px", borderRadius: "8px",
                background: copied ? "#10B98122" : "#131525",
                border: `1px solid ${copied ? "#10B981" : "#1E2540"}`,
                color: copied ? "#10B981" : "#94A3B8",
                fontSize: "13px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit"
              }}>
                {copied ? "\u2713 Copied!" : "Copy text"}
              </button>
              <button onClick={handleDownload} style={{
                flex: 1, padding: "11px", borderRadius: "8px", border: "1px solid #1E2540",
                background: "#131525", color: "#94A3B8",
                fontSize: "13px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit"
              }}>
                Download .txt
              </button>
            </div>
            <button onClick={reset} style={{
              width: "100%", padding: "11px", borderRadius: "8px", border: "none",
              background: "#6366F1", color: "#fff", fontSize: "13px",
              fontWeight: 700, cursor: "pointer", fontFamily: "inherit"
            }}>
              New Recording
            </button>
          </>
        )}

        <div style={{ textAlign: "center", marginTop: "24px", fontSize: "11px", color: "#1E2540" }}>
          Powered by OpenAI Whisper \u00B7 Your API key never leaves your browser
        </div>
      </div>
    </div>
  );
}
