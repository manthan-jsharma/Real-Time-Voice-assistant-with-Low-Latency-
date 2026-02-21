import os
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
os.environ["OMP_NUM_THREADS"] = "4"

from dotenv import load_dotenv
load_dotenv()

import asyncio
import json
import time
import wave
import io
import numpy as np
import torch
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from kokoro import KPipeline
from groq import AsyncGroq

torch.set_num_threads(4)

tts_pipeline = None
llm_client = None
tts_lock = asyncio.Lock()  

@asynccontextmanager
async def lifespan(app: FastAPI):
    global tts_pipeline, llm_client
    print("\n🚀 Starting Server Setup...")
    
    llm_client = AsyncGroq(api_key=os.environ.get("GROQ_API_KEY"))
    
    print("⏳ Loading Kokoro (TTS)...")
    tts_pipeline = KPipeline(lang_code='a', device='cpu') 
    
    print("✅ All models safely loaded into memory!")
    yield
    print("\n🛑 Shutting down...")

app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

class VoiceSession:
    def __init__(self, websocket: WebSocket):
        self.ws = websocket
        self.audio_queue = asyncio.Queue()
        self.is_running = True
        self.audio_buffer = bytearray()
        self.llm_task = None
        self.total_e2e_start = 0
        self.interrupt_flag = False

    async def broadcast_telemetry(self, stage: str, value_ms: float, token_count: int = 0, char_count: int = 0, audio_secs: float = 0):
        try:
            if stage in ["stt", "llm", "tts", "e2e"]:
                key = f"{stage}_ms" if stage in ["stt", "e2e"] else f"{stage}_first_{'token' if stage=='llm' else 'chunk'}_ms"
                await self.ws.send_json({"type": "latency", "data": {key: int(value_ms)}})

            if audio_secs > 0 or token_count > 0 or char_count > 0:
                await self.ws.send_json({
                    "type": "telemetry", 
                    "data": {"audio_secs_processed": audio_secs, "llm_tokens_generated": token_count, "tts_chars_generated": char_count}
                })
        except: pass

    async def process_stt(self):
        global llm_client
        while self.is_running:
            try:
                chunk = await asyncio.wait_for(self.audio_queue.get(), timeout=0.8)
                self.audio_buffer.extend(chunk)
                
            except asyncio.TimeoutError:
                if len(self.audio_buffer) >= 16000:
                    try:
                        self.total_e2e_start = time.perf_counter()
                        stt_start = time.perf_counter()
                        
                        wav_io = io.BytesIO()
                        with wave.open(wav_io, 'wb') as wav_file:
                            wav_file.setnchannels(1)
                            wav_file.setsampwidth(2)
                            wav_file.setframerate(16000)
                            wav_file.writeframes(self.audio_buffer)
                        wav_io.seek(0)
                        
                        transcription = await llm_client.audio.transcriptions.create(
                            file=("audio.wav", wav_io.read()),
                            model="whisper-large-v3-turbo",
                            response_format="text"
                        )
                        text = transcription.strip()
                        
                        stt_time_ms = (time.perf_counter() - stt_start) * 1000
                        audio_duration_secs = len(self.audio_buffer) / 32000.0
                        self.audio_buffer.clear()
                        
                        if text:
                            print(f"🎙️ User: {text}")
                            await self.ws.send_json({"type": "transcript", "text": text})
                            await self.broadcast_telemetry("stt", stt_time_ms, audio_secs=audio_duration_secs)
                            
                            if self.llm_task and not self.llm_task.done():
                                self.llm_task.cancel()
                                
                            self.interrupt_flag = False 
                            
                            self.llm_task = asyncio.create_task(self.process_llm(text))
                            
                    except Exception as e:
                        print(f"❌ STT Error: {e}")
                        self.audio_buffer.clear()

    async def process_llm(self, prompt: str):
        global llm_client
        try:
            llm_start = time.perf_counter()
            stream = await llm_client.chat.completions.create(
                messages=[
                    {
                        "role": "system", 
    "content": "You are a conversational human-like voice assistant. You MUST start your response with filler words according to the text, such as 'Well.', 'Okay.' 'let me think'  Keep all subsequent sentences short but human like. Never write a sentence longer than 30 words. and speak all the filler words with humaness, take appropriate pauses like humans and basically converse naturally"},
                    {"role": "user", "content": prompt}
                ],
                model="llama-3.3-70b-versatile",
                stream=True,
                max_tokens=150
            )
            
            sentence_buffer = ""
            first_token_received = False
            token_count = 0
            
            async for chunk in stream:
                if self.interrupt_flag: break 
                
                if chunk.choices[0].delta.content:
                    text_chunk = chunk.choices[0].delta.content
                    sentence_buffer += text_chunk
                    token_count += 1
                    
                    if not first_token_received:
                        await self.broadcast_telemetry("llm", (time.perf_counter() - llm_start) * 1000)
                        first_token_received = True
                        
                    await self.ws.send_json({"type": "text_chunk", "text": text_chunk})
                    
                    if any(punct in text_chunk for punct in [".", "?", "!"]):
                        await self.process_tts(sentence_buffer.strip())
                        await self.broadcast_telemetry("", 0, token_count=token_count)
                        token_count = 0
                        sentence_buffer = ""
                        
            if sentence_buffer and not self.interrupt_flag:
                await self.process_tts(sentence_buffer.strip())
                await self.broadcast_telemetry("", 0, token_count=token_count)

        except asyncio.CancelledError:
            print("🛑 LLM Interrupted by Barge-in.")

    async def process_tts(self, text: str):
        global tts_pipeline, tts_lock
        if not text or self.interrupt_flag: return
        try:
            tts_start = time.perf_counter()
            def generate_audio():
                return list(tts_pipeline(text, voice='af_heart', speed=1.1))
            
            async with tts_lock:
                audio_chunks = await asyncio.to_thread(generate_audio)
            
            first_chunk_sent = False
            for i, (gs, ps, audio_data) in enumerate(audio_chunks):
                if self.interrupt_flag: break 
                
                if isinstance(audio_data, torch.Tensor):
                    audio_np = audio_data.detach().cpu().numpy()
                else:
                    audio_np = audio_data

                if not first_chunk_sent:
                    await self.broadcast_telemetry("tts", (time.perf_counter() - tts_start) * 1000, char_count=len(text))
                    await self.broadcast_telemetry("e2e", (time.perf_counter() - self.total_e2e_start) * 1000)
                    first_chunk_sent = True

                audio_int16 = (audio_np * 32767).astype(np.int16)
                await self.ws.send_bytes(audio_int16.tobytes())
                
        except Exception as e:
            print(f"❌ TTS Error: {e}")


    async def start(self):
        asyncio.create_task(self.process_stt())


@app.websocket("/ws/stream")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    session = VoiceSession(websocket)
    await session.start()
    print("🔌 New client connected!")
    
    try:
        while True:
            message = await websocket.receive()
            if "bytes" in message:
                await session.audio_queue.put(message["bytes"])
            elif "text" in message:
                data = json.loads(message["text"])
                if data.get("type") == "interrupt":
                    session.interrupt_flag = True 
                    session.audio_buffer.clear()
                    if session.llm_task:
                        session.llm_task.cancel()
    except WebSocketDisconnect:
        print("🔌 Client disconnected.")
        session.is_running = False