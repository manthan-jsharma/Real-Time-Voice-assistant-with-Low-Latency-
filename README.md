
---

# 🎙️ Real-Time Voice AI System (Low Latency)

A full-duplex, streaming voice assistant prototype designed for natural human-computer interaction. This system features an ultra-low latency pipeline converting Speech-to-Text (STT), generating AI responses (LLM), and synthesizing Text-to-Speech (TTS) in near real-time.

It includes advanced features like conversational fillers to mask latency, chunk-based streaming TTS, and local Voice Activity Detection (VAD) for instant barge-in (interruption).

## 🚀 Key Features

- **Real-Time Streaming:** End-to-end WebSocket architecture for continuous bidirectional audio streaming.
- **Natural Conversation:** Injects natural filler words ("Hmm...", "Let me think...") while the LLM generates the primary response to eliminate perceived dead air.
- **Barge-In Support:** Client-side volume-based VAD allows users to interrupt the AI mid-sentence, instantly halting audio playback and cancelling backend LLM/TTS generation tasks.
- **Dynamic Telemetry:** Frontend UI tracks and displays real-time latency metrics and live cost estimation.

---

## 🛠️ Tech Stack

### Frontend

- **Framework:** Next.js 14 (App Router), React
- **Styling:** Tailwind CSS
- **Audio & Networking:** Web Audio API (`AudioContext`, `ScriptProcessor` for VAD), WebSockets
- **Icons:** Lucide React

### Backend

- **Framework:** FastAPI (Python), Uvicorn
- **STT (Speech-to-Text):** Groq API (`whisper-large-v3-turbo`)
- **LLM (Text Generation):** Groq API (`llama-3.3-70b-versatile`)
- **TTS (Text-to-Speech):** Kokoro TTS (Running locally on CPU)
- **Concurrency:** `asyncio` for non-blocking task management

---

## ⚙️ Setup Instructions

### Prerequisites

- Node.js (v18+)
- Python (3.10+)
- [Groq API Key](https://console.groq.com/keys)

### 1. Backend Setup

1. Navigate to the backend directory:

```bash
cd backend

```

2. Create and activate a virtual environment:

```bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

```

3. Install dependencies:

```bash
pip install -r requirements.txt

```

4. Set up your environment variables by creating a `.env` file in the `backend` directory:

```env
GROQ_API_KEY=your_groq_api_key_here

```

5. Start the FastAPI server:

```bash
uvicorn server:app --host 0.0.0.0 --port 8000 --reload

```

### 2. Frontend Setup

1. Navigate to the frontend directory:

```bash
cd frontend

```

2. Install dependencies:

```bash
npm install

```

3. Start the Next.js development server:

```bash
npm run dev

```

4. Open your browser and navigate to `http://localhost:3000`. Allow microphone permissions when prompted.

---

## 🏗️ Architecture Diagram

### 1. Prototype Architecture (Current Implementation)

```text
[ Browser / Client ]                                   [ FastAPI Backend ]
       |                                                        |
       |--(1) Raw Audio Chunks (WebSocket) -------------------->|
       |                                                        |-- STT (Groq Whisper)
       |                                                        |-- LLM (Groq Llama 3)
       |<-(2) Conversational Fillers ("Hmm..") (WebSocket) -----|
       |<-(3) Text Chunks (for UI) (WebSocket) -----------------|
       |                                                        |-- TTS (Kokoro Local)
       |<-(4) Int16 Audio Bytes (WebSocket) --------------------|
       |                                                        |
[ User Speaks ] -> Triggers VAD -> Sends {"type": "interrupt"} -> Cancels Backend Tasks

```

### 2. Scalability Architecture (For 10,000+ Concurrent Users)

To scale this system for 10,000 simultaneous users, the current monolithic stateful WebSocket design must be decoupled:

1. **Ingestion Layer:** Use an Application Load Balancer (ALB) with WebSocket sticky sessions routing to lightweight Node.js/Go connection managers.
2. **Message Broker:** Stream audio chunks into a Pub/Sub system (e.g., Redis Streams or Apache Kafka).
3. **Inference Worker Nodes:** Decouple STT, LLM, and TTS into separate microservices. Deploy Kokoro TTS on GPU-backed Kubernetes pods managed by KEDA (Kubernetes Event-driven Autoscaling) to dynamically scale based on queue depth.
4. **VAD Optimization:** Replace simple volume-threshold VAD with a client-side WebAssembly (WASM) VAD (like Silero) to prevent background noise from keeping active WebSocket connections open unnecessarily.

---

## ⏱️ Latency Measurement Table

_Note: These metrics are tracked dynamically in the application UI. The following represents average benchmark targets achieved during testing._

| Processing Stage    | Target Latency | Description                                                                   |
| ------------------- | -------------- | ----------------------------------------------------------------------------- |
| **STT (Whisper)**   | ~300 - 700ms   | Time taken to transcribe the accumulated audio buffer via Groq API.           |
| **LLM TTFT**        | ~400 - 600ms   | Time to First Token (TTFT). Fast inference via Llama 3 on Groq.               |
| **TTS First Chunk** | ~500 - 10000ms  | Time to synthesize the first sentence chunk via Kokoro (CPU bound).           |
| **Total E2E**       | **< 2000-2500ms**   | Total time from the user stopping speech to the first byte of audio playback. |

_To further reduce perceived latency, the system immediately plays a synthesized filler word ("Hmm...") while the LLM generates the factual response, dropping perceived E2E latency to < 800ms._

---

## 💰 Cost Estimation Sheet

**Assumptions for Scale:**

- **Daily Active Users (DAU):** 10,000
- **Average Usage:** 5 minutes of active conversation per user/day.
- **Speaking Rate:** 150 words per minute.
- **Tokens/Characters:** ~1.3 tokens per word; ~6 characters per word.
- **Pricing Rates:** Groq STT ($0.0043/min), Groq LLM Llama-3-70B ($0.60/1M tokens), Cloud TTS equivalent for Kokoro scale ($15.00/1M chars).

### Daily Cost Breakdown

| Service               | Formula                                                  | Est. Daily Cost |
| --------------------- | -------------------------------------------------------- | --------------- |
| **STT (Whisper)**     | 10k users _ 5 mins _ $0.0043                             | $215.00         |
| **LLM (Llama 3)**     | 10k users _ 5m _ 150w _ 1.3t = 9.75M tokens _ ($0.60/1M) | $5.85           |
| **TTS (Cloud Equiv)** | 10k users _ 5m _ 150w _ 6c = 45M chars _ ($15.00/1M)     | $675.00         |
| **Total Daily Cost**  | STT + LLM + TTS                                          | **$895.85**     |

### Total Estimates

- **Cost per user per day:** ~$0.089
- **Estimated Monthly OPEX:** ~$26,875.50

### 📉 3 Strategies for Cost Reduction

1. **Strict Client-Side VAD:** Ensure no "silence" is streamed to the backend. By clipping dead air exactly when speech stops using an AI-based VAD (like Silero-VAD), we drastically cut STT per-minute billing.
2. **Semantic Caching:** Implement a Redis cache for LLM + TTS pairs. If multiple users ask a common question ("What's the weather?"), serve the cached audio file instead of running the inference pipeline again.
3. **Tiered LLM Routing:** Use a highly efficient, cheaper model (e.g., Llama-3-8B) for standard greetings or basic intents, and only route complex reasoning tasks to the expensive 70B model.

---
