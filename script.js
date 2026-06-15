const videoFileInput = document.getElementById('videoFile');
const renderButton = document.getElementById('renderButton');
const originalVideo = document.getElementById('originalVideo');
const finalVideo = document.getElementById('finalVideo');
const statusText = document.getElementById('status');
const downloadLink = document.getElementById('downloadLink');

let originalUrl = null;
let finalUrl = null;
let selectedVideo = null;

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.style.color = isError ? '#f87171' : '#94a3b8';
}

function revokeUrls() {
  if (originalUrl) URL.revokeObjectURL(originalUrl);
  if (finalUrl) URL.revokeObjectURL(finalUrl);
  originalUrl = null;
  finalUrl = null;
}

async function decodeAudioFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  return await audioContext.decodeAudioData(arrayBuffer);
}

function makeWavBlob(buffer) {
  const channels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length * channels * 2;
  const bufferArray = new ArrayBuffer(44 + length);
  const view = new DataView(bufferArray);

  function writeString(offset, string) {
    for (let i = 0; i < string.length; i += 1) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + length, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, length, true);

  let offset = 44;
  const interleaved = new Float32Array(buffer.length * channels);

  for (let i = 0; i < buffer.length; i += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      interleaved[i * channels + channel] = buffer.getChannelData(channel)[i];
    }
  }

  for (let i = 0; i < interleaved.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, interleaved[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  return new Blob([bufferArray], { type: 'audio/wav' });
}

function separateVoiceAndMusic(buffer) {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const sampleRate = buffer.sampleRate;
  const output = new AudioContext().createBuffer(channels, length, sampleRate);

  if (channels === 1) {
    output.copyToChannel(buffer.getChannelData(0), 0);
    return output;
  }

  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const outLeft = output.getChannelData(0);
  const outRight = output.getChannelData(1);

  for (let i = 0; i < length; i += 1) {
    const diff = left[i] - right[i];
    outLeft[i] = diff * 0.5;
    outRight[i] = -diff * 0.5;
  }

  return output;
}

async function mergeVideoWithAudio(processedBuffer) {
  if (!originalVideo.src) {
    throw new Error('Original video source is missing.');
  }

  originalVideo.muted = true;
  originalVideo.currentTime = 0;
  const videoStream = originalVideo.captureStream();
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const destination = audioContext.createMediaStreamDestination();
  const source = audioContext.createBufferSource();
  source.buffer = processedBuffer;
  source.connect(destination);
  source.start();

  const combinedStream = new MediaStream([
    ...videoStream.getVideoTracks(),
    ...destination.stream.getAudioTracks(),
  ]);

  const supportedType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
    ? 'video/webm;codecs=vp8,opus'
    : 'video/webm';

  const recorder = new MediaRecorder(combinedStream, { mimeType: supportedType });
  const chunks = [];

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const recordingPromise = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: supportedType }));
    recorder.onerror = (event) => reject(event.error);
  });

  recorder.start(250);

  await originalVideo.play();

  await new Promise((resolve, reject) => {
    originalVideo.addEventListener('ended', resolve, { once: true });
    originalVideo.addEventListener('error', () => reject(new Error('Video playback failed during render.')), { once: true });
  });

  recorder.stop();
  source.stop();
  const result = await recordingPromise;
  await audioContext.close();
  return result;
}

videoFileInput.addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) {
    setStatus('No video selected.');
    renderButton.disabled = true;
    return;
  }

  selectedVideo = file;
  revokeUrls();
  originalUrl = URL.createObjectURL(file);
  originalVideo.src = originalUrl;
  originalVideo.load();
  finalVideo.removeAttribute('src');
  renderButton.disabled = false;
  downloadLink.hidden = true;
  setStatus('Video loaded. Click "Remove Voice & Render" to start the workflow.');
});

renderButton.addEventListener('click', async () => {
  if (!selectedVideo) return;

  setStatus('Extracting audio from the video...');
  renderButton.disabled = true;

  try {
    const audioBuffer = await decodeAudioFile(selectedVideo);
    setStatus('Separating voice from the background audio...');
    const processedBuffer = separateVoiceAndMusic(audioBuffer);
    setStatus('Rendering the final video with processed audio...');
    const renderedBlob = await mergeVideoWithAudio(processedBuffer);
    finalUrl = URL.createObjectURL(renderedBlob);
    finalVideo.src = finalUrl;
    finalVideo.load();
    downloadLink.href = finalUrl;
    downloadLink.hidden = false;
    setStatus('Final video is ready. Preview it and download the result.');
  } catch (error) {
    setStatus(`Workflow failed: ${error.message}`, true);
    console.error(error);
  } finally {
    renderButton.disabled = false;
  }
});
