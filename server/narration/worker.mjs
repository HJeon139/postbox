// The narration worker: Kokoro text-to-speech in its own process, so its native audio and ONNX packages
// never run inside Postbox’s server. The parent (server/narration/narrator.mjs) sends { id, text, voice,
// speed } over IPC and gets back { id, wav (base64), ms }. The model downloads once, on first use, into
// POSTBOX_MODELS_DIR.

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
/** @type {any} */
let tts = null;

async function load() {
  if (tts) return tts;
  const { env } = await import('@huggingface/transformers');
  if (process.env.POSTBOX_MODELS_DIR) env.cacheDir = process.env.POSTBOX_MODELS_DIR;
  const { KokoroTTS } = await import('kokoro-js');
  tts = await KokoroTTS.from_pretrained(MODEL, {
    dtype: 'q8',
    device: 'cpu',
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) process.send?.({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
    },
  });
  return tts;
}

process.on('message', async (/** @type {any} */ m) => {
  if (m?.type !== 'speak') return;
  try {
    const t = await load();
    const audio = await t.generate(String(m.text), { voice: m.voice || 'af_heart', speed: m.speed || 1 });
    const wav = Buffer.from(audio.toWav());
    process.send?.({ type: 'done', id: m.id, wav: wav.toString('base64'), ms: Math.round((audio.audio.length / audio.sampling_rate) * 1000) });
  } catch (e) {
    process.send?.({ type: 'error', id: m.id, message: e.message });
  }
});
process.send?.({ type: 'ready' });
