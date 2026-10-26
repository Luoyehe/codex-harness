/** One browser-owned WebRTC transport. No credentials or audio are persisted. */
export class RealtimeMedia {
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private microphone?: MediaStream;
  private remote?: MediaStream;
  private closed = false;
  private answer?: string;
  private applying: Promise<void> = Promise.resolve();
  private abort = new AbortController();
  constructor(
    private audio: HTMLAudioElement,
    private failed: (message: string, fatal?: boolean) => void,
  ) {}
  static supported(): boolean {
    return (
      globalThis.isSecureContext === true &&
      typeof RTCPeerConnection === 'function' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function'
    );
  }
  async offer(): Promise<string> {
    if (!RealtimeMedia.supported())
      throw new Error('当前浏览器需要 HTTPS、WebRTC 和麦克风支持。可以选择仅文字实时会话。');
    const peer = (this.peer = new RTCPeerConnection());
    peer.ontrack = (event) => {
      if (this.closed) {
        event.track.stop();
        return;
      }
      this.remote = event.streams[0] ?? new MediaStream([event.track]);
      this.audio.srcObject = this.remote;
      void this.audio.play().catch(() => {
        if (!this.closed) this.failed('浏览器阻止了自动播放，请点击“播放语音”。');
      });
    };
    peer.onconnectionstatechange = () => {
      if (!this.closed && ['failed', 'closed'].includes(peer.connectionState)) {
        this.close();
        this.failed('音频连接已中断，麦克风已关闭并请求结束本次语音。', true);
      }
    };
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    if (this.closed) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('语音启动已取消。');
    }
    this.microphone = stream;
    for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
    // The native sideband owns commands and canonical transcripts. Do not send duplicate
    // application commands over the browser data channel or trust it as history proof.
    this.channel = peer.createDataChannel('oai-events');
    this.channel.onmessage = () => {};
    const offer = await peer.createOffer();
    if (this.closed) throw new Error('语音启动已取消。');
    await peer.setLocalDescription(offer);
    if (peer.iceGatheringState !== 'complete')
      await new Promise<void>((resolve, reject) => {
        const done = (error?: Error) => {
          clearTimeout(timer);
          peer.removeEventListener('icegatheringstatechange', change);
          this.abort.signal.removeEventListener('abort', cancelled);
          error ? reject(error) : resolve();
        };
        const change = () => {
            if (peer.iceGatheringState === 'complete') done();
          },
          cancelled = () => done(new Error('语音启动已取消。'));
        const timer = setTimeout(() => done(new Error('音频网络协商超时，尚未启动语音。')), 10000);
        peer.addEventListener('icegatheringstatechange', change);
        this.abort.signal.addEventListener('abort', cancelled, { once: true });
        if (this.closed) cancelled();
        else change();
      });
    const sdp = peer.localDescription?.sdp;
    if (this.closed || !sdp || new TextEncoder().encode(sdp).length > 65536)
      throw new Error('音频网络协商没有返回有效描述。');
    return sdp;
  }
  accept(sdp: string): Promise<void> {
    this.applying = this.applying.then(async () => {
      if (this.closed || !this.peer || this.answer === sdp) return;
      if (this.answer !== undefined || new TextEncoder().encode(sdp).length > 65536)
        throw new Error('语音服务返回了冲突或过大的连接描述。');
      await this.peer.setRemoteDescription({ type: 'answer', sdp });
      this.answer = sdp;
    });
    return this.applying;
  }
  mute(muted: boolean) {
    this.microphone?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.microphone?.getTracks().forEach((track) => track.stop());
    this.remote?.getTracks().forEach((track) => track.stop());
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
    }
    if (this.peer) {
      this.peer.ontrack = null;
      this.peer.onconnectionstatechange = null;
      this.peer.close();
    }
    this.audio.pause();
    this.audio.srcObject = null;
  }
}
