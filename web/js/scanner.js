// Camera QR scanning in the browser. Uses the phone's own detector when it has one (Android Chrome),
// otherwise the built-in decoder in qrdecode.js (iPhone Safari, desktop browsers).
import { decodeQR } from './qrdecode.js';

export const cameraSupported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

export async function startScanner(video, onCode, { onError } = {}) {
  if (!cameraSupported()) throw new Error('This browser cannot open the camera. Use Chrome or Safari over https, or type the Box ID.');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    throw new Error(denied ? 'Camera is blocked. Allow the camera for this site in the browser settings, then press Start again.' : 'Cannot open the camera: ' + (e && e.message ? e.message : e));
  }
  video.setAttribute('playsinline', ''); video.muted = true; video.srcObject = stream;
  await video.play();

  let detector = null;
  try { if ('BarcodeDetector' in window) detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (_) { detector = null; }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let running = true, tick = 0;

  const loop = async () => {
    if (!running) return;
    try {
      if (video.readyState >= 2 && video.videoWidth) {
        tick++;
        let text = null;
        if (detector) {
          try { const r = await detector.detect(video); if (r && r.length) text = r[0].rawValue; } catch (_) { detector = null; }
        }
        if (!text && (!detector || tick % 2 === 0)) {
          const scale = Math.min(1, 960 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          text = decodeQR(ctx.getImageData(0, 0, canvas.width, canvas.height));
        }
        if (text) onCode(text);
      }
    } catch (e) { if (onError) onError(e); }
    if (running) setTimeout(loop, 90);
  };
  loop();

  const track = stream.getVideoTracks()[0];
  const caps = track && track.getCapabilities ? track.getCapabilities() : {};
  return {
    hasTorch: !!caps.torch,
    async setTorch(on) { if (caps.torch) await track.applyConstraints({ advanced: [{ torch: !!on }] }); },
    stop() { running = false; stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; },
  };
}

let audio = null;
export function beep(ok) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'sine'; o.frequency.value = ok ? 880 : 220; g.gain.value = 0.15;
    o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + (ok ? 0.12 : 0.35));
  } catch (_) { /* sound is optional */ }
  try { if (navigator.vibrate) navigator.vibrate(ok ? 60 : [120, 60, 120]); } catch (_) { /* optional */ }
}
