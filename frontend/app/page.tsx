"use client";

import { useState, useEffect, useRef } from "react";
import {
  Activity,
  Zap,
  Server,
  Mic,
  Square,
  RefreshCcw,
  DollarSign,
  Hand,
} from "lucide-react";

export default function ProductionVoiceAI() {
  const [status, setStatus] = useState<
    "idle" | "recording" | "thinking" | "speaking"
  >("idle");
  const [messages, setMessages] = useState<any[]>([]);
  const [interimUserText, setInterimUserText] = useState("");
  const [volume, setVolume] = useState(0);
  const [isVADActive, setIsVADActive] = useState(false);
  const [reconnectCount, setReconnectCount] = useState(0);

  const [metrics, setMetrics] = useState({
    stt_ms: 0,
    llm_first_token_ms: 0,
    tts_first_chunk_ms: 0,
    e2e_ms: 0,
  });
  const [telemetry, setTelemetry] = useState({
    audio_secs: 0,
    tokens: 0,
    chars: 0,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const speechRecognitionRef = useRef<any>(null);

  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const handleIncomingToken = (token: string) => {
    setStatus("speaking");
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "ai" && last.status === "streaming") {
        return [
          ...prev.slice(0, -1),
          { ...last, content: last.content + token },
        ];
      }
      return [...prev, { role: "ai", content: token, status: "streaming" }];
    });
  };

  const playRawAudio = async (arrayBuffer: ArrayBuffer) => {
    if (statusRef.current !== "speaking") {
      return;
    }

    if (!audioCtxRef.current) {
      const AudioContextClass =
        window.AudioContext || (window as any).webkitAudioContext;
      audioCtxRef.current = new AudioContextClass({ sampleRate: 24000 });
    }
    const int16Array = new Int16Array(arrayBuffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++)
      float32Array[i] = int16Array[i] / 32768.0;

    const audioBuffer = audioCtxRef.current.createBuffer(
      1,
      float32Array.length,
      24000
    );
    audioBuffer.getChannelData(0).set(float32Array);

    const source = audioCtxRef.current.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtxRef.current.destination);

    const now = audioCtxRef.current.currentTime;
    nextPlayTimeRef.current = Math.max(nextPlayTimeRef.current, now);
    source.start(nextPlayTimeRef.current);
    nextPlayTimeRef.current += audioBuffer.duration;
  };
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout;

    const connect = () => {
      if (
        wsRef.current?.readyState === WebSocket.OPEN ||
        wsRef.current?.readyState === WebSocket.CONNECTING
      )
        return;

      ws = new WebSocket("ws://localhost:8000/ws/stream");
      wsRef.current = ws;
      ws.onopen = () => setReconnectCount(0);

      ws.onmessage = async (event) => {
        if (typeof event.data === "string") {
          const data = JSON.parse(event.data);
          if (data.type === "text_chunk") {
            handleIncomingToken(data.text);
          } else if (data.type === "transcript") {
            setInterimUserText("");
            setMessages((prev) => [
              ...prev,
              { role: "user", content: data.text },
            ]);
            setStatus("thinking");
          } else if (data.type === "latency")
            setMetrics((prev) => ({ ...prev, ...data.data }));
          else if (data.type === "telemetry") {
            setTelemetry((prev) => ({
              audio_secs:
                prev.audio_secs + (data.data.audio_secs_processed || 0),
              tokens: prev.tokens + (data.data.llm_tokens_generated || 0),
              chars: prev.chars + (data.data.tts_chars_generated || 0),
            }));
          }
        } else if (event.data instanceof Blob) {
          const arrayBuffer = await event.data.arrayBuffer();
          await playRawAudio(arrayBuffer);
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        setReconnectCount((prev) => {
          const newCount = prev + 1;
          reconnectTimeout = setTimeout(
            connect,
            Math.min(10000, Math.pow(2, newCount) * 1000)
          );
          return newCount;
        });
      };
    };

    connect();
    return () => {
      clearTimeout(reconnectTimeout);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, []);

  const interruptAI = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "interrupt" }));

      if (audioCtxRef.current) {
        audioCtxRef.current.close();
        audioCtxRef.current = null;
        nextPlayTimeRef.current = 0;
      }

      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.status === "streaming") {
          return [
            ...prev.slice(0, -1),
            {
              ...last,
              status: "done",
              content: last.content + " [Interrupted]",
            },
          ];
        }
        return prev;
      });

      setStatus("recording");
    }
  };

  const startMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true },
      });
      streamRef.current = stream;

      const SpeechRecognition =
        (window as any).SpeechRecognition ||
        (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.onresult = (event: any) => {
          let currentInterim = "";
          for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (!event.results[i].isFinal)
              currentInterim += event.results[i][0].transcript;
          }
          setInterimUserText(currentInterim);
        };
        recognition.start();
        speechRecognitionRef.current = recognition;
      }

      const ctx = new AudioContext({ sampleRate: 16000 });
      const analyzer = ctx.createAnalyser();
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);

      source.connect(analyzer);
      analyzer.connect(processor);
      processor.connect(ctx.destination);

      const dataArr = new Uint8Array(analyzer.frequencyBinCount);

      processor.onaudioprocess = (e) => {
        analyzer.getByteFrequencyData(dataArr);
        const avg = dataArr.reduce((a, b) => a + b) / dataArr.length;
        setVolume(avg);

        if (avg > 12) {
          setIsVADActive(true);

          if (
            statusRef.current === "speaking" ||
            statusRef.current === "thinking"
          ) {
            interruptAI();
          }

          if (wsRef.current?.readyState === WebSocket.OPEN) {
            const input = e.inputBuffer.getChannelData(0);
            const output = new Int16Array(input.length);
            for (let i = 0; i < input.length; i++) output[i] = input[i] * 32768;
            wsRef.current.send(output.buffer);
          }
        } else {
          setIsVADActive(false);
        }
      };
      setStatus("recording");
    } catch (err) {
      console.error("Mic error:", err);
    }
  };

  const stopSession = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (speechRecognitionRef.current) {
      speechRecognitionRef.current.stop();
      speechRecognitionRef.current = null;
    }

    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "interrupt" }));
    }

    setStatus("idle");
    setInterimUserText("");
    setIsVADActive(false);
    setVolume(0);
  };

  return (
    <div className="min-h-screen bg-[#0a0c12] text-slate-200 font-sans p-4 md:p-8">
      <header className="max-w-6xl mx-auto flex justify-between items-center mb-8">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center font-bold text-white">
            V
          </div>
          <h1 className="text-xl font-bold tracking-tight">
            Voice<span className="text-indigo-500">AI</span>
          </h1>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden md:flex items-center gap-2 px-3 py-1 bg-slate-900 border border-slate-800 rounded-full">
            <Server
              size={14}
              className={
                reconnectCount === 0 ? "text-emerald-500" : "text-amber-500"
              }
            />
            <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">
              {reconnectCount === 0
                ? "Connected"
                : `Reconnecting (${reconnectCount})`}
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2 space-y-6">
          <div className="bg-[#13161f] border border-slate-800 rounded-3xl p-8 flex flex-col items-center justify-center relative overflow-hidden h-[300px]">
            <div className="relative mb-8 flex items-center gap-6">
              <button
                onClick={interruptAI}
                disabled={status !== "speaking" && status !== "thinking"}
                className={`flex flex-col items-center gap-2 transition-all ${
                  status === "speaking" || status === "thinking"
                    ? "opacity-100 hover:scale-105 cursor-pointer text-rose-500"
                    : "opacity-30 cursor-not-allowed text-slate-600"
                }`}
              >
                <div className="w-12 h-12 rounded-full border-2 border-current flex items-center justify-center bg-rose-500/10">
                  <Hand size={20} />
                </div>
                <span className="text-[10px] font-bold uppercase tracking-widest">
                  Stop AI
                </span>
              </button>

              <div className="relative">
                <div
                  className={`absolute inset-[-20px] rounded-full border border-indigo-500/20 ${
                    status !== "idle" ? "animate-ping" : ""
                  }`}
                />
                <div
                  className={`w-32 h-32 rounded-full flex items-center justify-center text-4xl cursor-pointer transition-all duration-500 z-10 relative
                    ${
                      status === "recording"
                        ? "bg-rose-500 shadow-[0_0_50px_rgba(244,63,94,0.4)]"
                        : status === "speaking"
                        ? "bg-emerald-500 shadow-[0_0_50px_rgba(16,185,129,0.4)] scale-110"
                        : "bg-indigo-600 hover:scale-105 shadow-[0_0_30px_rgba(79,70,229,0.3)]"
                    }
                  `}
                  onClick={status === "idle" ? startMic : interruptAI}
                >
                  {status === "recording" ? (
                    <Square fill="currentColor" />
                  ) : (
                    <Mic fill="currentColor" />
                  )}
                </div>
              </div>
              <button
                onClick={stopSession}
                disabled={status === "idle"}
                className={`flex flex-col items-center gap-2 transition-all ${
                  status !== "idle"
                    ? "opacity-100 hover:scale-105 cursor-pointer text-rose-500"
                    : "opacity-30 cursor-not-allowed text-slate-600"
                }`}
              >
                <div className="w-12 h-12 rounded-full border-2 border-current flex items-center justify-center bg-rose-500/10">
                  <Square size={16} fill="currentColor" />
                </div>
                <span className="text-[10px] font-bold uppercase tracking-widest">
                  End Call
                </span>
              </button>

              <div className="w-12 h-12" />
            </div>

            <div className="flex flex-col items-center gap-2">
              <span className="text-sm font-medium text-slate-400 uppercase tracking-widest">
                {status === "idle"
                  ? "Click to start session"
                  : status === "recording"
                  ? "Listening..."
                  : status}
              </span>
              <div className="flex items-center gap-1 h-4">
                {[...Array(16)].map((_, i) => (
                  <div
                    key={i}
                    className="w-1 bg-indigo-500 rounded-full transition-all duration-75"
                    style={{
                      height:
                        status === "idle"
                          ? "4px"
                          : `${Math.max(4, volume * Math.random() * 1.5)}px`,
                    }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="bg-[#13161f] border border-slate-800 rounded-3xl h-[400px] flex flex-col">
            <div className="p-4 border-b border-slate-800 flex justify-between">
              <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">
                Live Transcript
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={`flex ${
                    m.role === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  <div
                    className={`p-4 rounded-2xl max-w-[85%] leading-relaxed ${
                      m.role === "user"
                        ? "bg-indigo-600 text-white"
                        : "bg-slate-800 border border-slate-700 text-slate-200"
                    }`}
                  >
                    {m.content}
                    {m.status === "streaming" && (
                      <span className="inline-block w-2 h-4 ml-1 bg-indigo-400 animate-pulse align-middle" />
                    )}
                  </div>
                </div>
              ))}

              {interimUserText && (
                <div className="flex justify-end">
                  <div className="p-4 rounded-2xl max-w-[85%] bg-indigo-600/50 text-white/70 italic border border-indigo-500/30">
                    {interimUserText} <span className="animate-pulse">...</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        <aside className="space-y-6">
          <div className="bg-[#13161f] border border-slate-800 rounded-3xl p-6">
            <div className="flex items-center gap-2 mb-6">
              <Zap size={16} className="text-amber-400" />
              <h2 className="text-xs font-bold uppercase tracking-widest">
                Real-Time Metrics
              </h2>
            </div>
            <div className="space-y-4">
              <LatencyItem
                label="STT (Groq Whisper)"
                value={metrics.stt_ms || 0}
                target={400}
              />
              <LatencyItem
                label="LLM TTFT"
                value={metrics.llm_first_token_ms || 0}
                target={600}
              />
              <LatencyItem
                label="TTS (Kokoro CPU)"
                value={metrics.tts_first_chunk_ms || 0}
                target={1500}
              />
              <div className="pt-4 mt-4 border-t border-slate-800 flex justify-between items-end">
                <span className="text-[10px] text-slate-500 font-bold uppercase">
                  Total E2E Latency
                </span>
                <span
                  className={`text-2xl font-black font-mono ${
                    metrics.e2e_ms < 2000 ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  {metrics.e2e_ms || 0}ms
                </span>
              </div>
            </div>
          </div>

          <CostEstimationPanel
            telemetry={telemetry}
            isVADActive={isVADActive}
          />
        </aside>
      </main>
    </div>
  );
}

function LatencyItem({
  label,
  value,
  target,
}: {
  label: string;
  value: number;
  target: number;
}) {
  const percent = Math.min((value / (target * 1.5)) * 100, 100);
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] font-mono">
        <span className="text-slate-400">{label}</span>
        <span
          className={value <= target ? "text-emerald-400" : "text-amber-400"}
        >
          {value}ms
        </span>
      </div>
      <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-1000 ${
            value === 0
              ? "bg-transparent"
              : value <= target
              ? "bg-indigo-500"
              : "bg-amber-500"
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

// 🚀 RESTORED THE FULL COST PANEL
function CostEstimationPanel({
  telemetry,
  isVADActive,
}: {
  telemetry: any;
  isVADActive: boolean;
}) {
  const RATES = {
    stt_per_min: 0.0043,
    llm_per_1m_tokens: 0.6,
    tts_per_1m_chars: 15.0,
  };

  const liveSTT = (telemetry.audio_secs / 60) * RATES.stt_per_min;
  const liveLLM = (telemetry.tokens / 1_000_000) * RATES.llm_per_1m_tokens;
  const liveTTS = (telemetry.chars / 1_000_000) * RATES.tts_per_1m_chars;
  const liveTotal = liveSTT + liveLLM + liveTTS;

  const DAILY_USERS = 10000;
  const DAYS_PER_MONTH = 30;

  const projectedSTT = DAILY_USERS * 2.5 * DAYS_PER_MONTH * RATES.stt_per_min;
  const projectedLLM =
    ((DAILY_USERS * 2.5 * 150 * 1.3) / 1_000_000) *
    DAYS_PER_MONTH *
    RATES.llm_per_1m_tokens;
  const projectedTTS =
    ((DAILY_USERS * 2.5 * 150 * 6) / 1_000_000) *
    DAYS_PER_MONTH *
    RATES.tts_per_1m_chars;
  const monthlyTotal = projectedSTT + projectedLLM + projectedTTS;

  return (
    <div className="bg-[#13161f] border border-slate-800 rounded-3xl p-6">
      <div className="flex justify-between items-start mb-6">
        <div className="flex items-center gap-2">
          <span className="text-emerald-400">
            <DollarSign size={16} />
          </span>
          <h2 className="text-xs font-bold uppercase tracking-widest text-slate-200">
            Dynamic Billing Engine
          </h2>
        </div>
        <div
          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
            isVADActive
              ? "bg-rose-500/20 text-rose-400 animate-pulse"
              : "bg-emerald-500/20 text-emerald-400"
          }`}
        >
          {isVADActive ? "INCURRING COSTS" : "SAVING BANDWIDTH"}
        </div>
      </div>

      <div className="bg-slate-900/50 border border-slate-700 p-4 rounded-xl mb-6">
        <span className="text-[10px] text-slate-500 font-bold uppercase block mb-1">
          Live Session Cost
        </span>
        <span className="text-3xl font-black font-mono text-indigo-400">
          ${liveTotal.toFixed(6)}
        </span>
        <div className="flex gap-4 mt-2 text-[9px] font-mono text-slate-500">
          <span>STT: ${liveSTT.toFixed(6)}</span>
          <span>LLM: ${liveLLM.toFixed(6)}</span>
          <span>TTS: ${liveTTS.toFixed(6)}</span>
        </div>
      </div>

      <div className="space-y-3 mb-4">
        <h3 className="text-[10px] text-slate-400 font-bold uppercase tracking-widest border-b border-slate-800 pb-2">
          10k Users Extrapolation
        </h3>
        <div className="flex justify-between text-[11px] font-mono text-slate-300">
          <span>STT (${RATES.stt_per_min}/min)</span>
          <span>
            ${projectedSTT.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
          </span>
        </div>
        <div className="flex justify-between text-[11px] font-mono text-slate-300">
          <span>LLM ($0.60/1M)</span>
          <span>
            ${projectedLLM.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
          </span>
        </div>
        <div className="flex justify-between text-[11px] font-mono text-slate-300">
          <span>TTS ($15.00/1M)</span>
          <span>
            ${projectedTTS.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
          </span>
        </div>
      </div>

      <div className="pt-3 border-t border-slate-800 flex justify-between items-end">
        <span className="text-[10px] text-slate-500 font-bold uppercase">
          Projected OPEX
        </span>
        <span className="text-lg font-black font-mono text-emerald-400">
          ${monthlyTotal.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
        </span>
      </div>
    </div>
  );
}
