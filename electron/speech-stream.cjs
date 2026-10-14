// Stream only to the trusted window that requested this particular playback.
function validateRequestId(requestId) {
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(requestId))) throw new Error('发音请求无效。');
}
async function streamSpeech(synthesize, sender, requestId) {
  validateRequestId(requestId);
  if (requestId === undefined) return synthesize({});
  const result = await synthesize({ onChunk: chunk => {
    if (!sender.isDestroyed()) sender.send('speech:chunk', { ...chunk, requestId });
  } });
  // The complete WAV remains in the main process for the disk cache.
  return result.streamed ? { engine: result.engine, cached: result.cached, streamed: true } : result;
}

class SpeechSessions {
  constructor({ cancel, notify }) { this.cancelCurrent = cancel; this.notify = notify; this.current = null; }
  start(sender, requestId, synthesize) {
    validateRequestId(requestId);
    this.current = { sender, requestId };
    this.notify(sender);
    return streamSpeech(synthesize, sender, requestId);
  }
  cancel(requestId, sender) {
    validateRequestId(requestId);
    if (sender && this.current?.sender !== sender) return Promise.resolve();
    // A stopped/reloaded window cannot cancel the newer window's request.
    if (requestId !== undefined && this.current?.requestId !== requestId) return Promise.resolve();
    this.current = null;
    return this.cancelCurrent();
  }
}
module.exports = { streamSpeech, SpeechSessions };
