// Registro de Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => console.log('Service Worker activo:', reg.scope))
      .catch((err) => console.error('Error Service Worker:', err));
  });
}

// Variables globales de la aplicacion
let db = null;
let audioContext = null;
let mediaRecorder = null;
let speechRecognition = null;
let audioChunks = [];
let currentTranscript = '';
let isRecording = false;
let isWhisperMode = false;
let lastAudioUrl = null;
let lastAudioRecord = null;
let wordCount = 0;

// Referencias del DOM
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnPlayLast = document.getElementById('btn-play-last');
const btnStartWhisper = document.getElementById('btn-start-whisper');
const liveTranscript = document.getElementById('live-transcript');
const mainAudioPlayer = document.getElementById('main-audio-player');
const lastAudioTime = document.getElementById('last-audio-time');
const recordingsList = document.getElementById('recordings-list');

const whisperScreen = document.getElementById('whisper-screen');
const currentWordEl = document.getElementById('current-word');
const wordsListEl = document.getElementById('words-list');
const loaderEl = document.getElementById('loader');

// CONFIGURACION DE INDEXEDDB
const DB_NAME = 'HermesAudioDB';
const DB_VERSION = 1;
const STORE_NAME = 'recordings';

function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (e) => reject(e.target.error);
    request.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };

    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };
  });
}

// CONFIGURACION DE MEDIA SESSION API (Control Bluetooth / Auriculares)
function setupMediaSession(title, transcript) {
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title || 'Ultima Grabacion',
      artist: 'Hermes Audio',
      album: transcript || 'Audio Amplificado'
    });

    navigator.mediaSession.setActionHandler('play', () => {
      if (mainAudioPlayer.src) {
        mainAudioPlayer.play();
      }
    });

    navigator.mediaSession.setActionHandler('pause', () => {
      if (mainAudioPlayer.src) {
        mainAudioPlayer.pause();
      }
    });
  }
}

// ACTIVACION COMPATIBLE DE AUDIO CONTEXT PARA IOS (Safari)
async function ensureAudioContextActive() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;

  if (!audioContext) {
    audioContext = new AudioCtx();
  }

  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
  return audioContext;
}

// INICIALIZACION DEL RECONOCIMIENTO DE VOZ
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    liveTranscript.textContent = 'SpeechRecognition no esta soportado en este navegador.';
    return null;
  }

  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'es-ES';

  rec.onresult = (event) => {
    let interimText = '';
    let finalText = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalText += event.results[i][0].transcript;
      } else {
        interimText += event.results[i][0].transcript;
      }
    }

    if (isWhisperMode) {
      if (interimText.trim().length > 0) {
        loaderEl.style.display = 'none';
        currentWordEl.textContent = interimText.trim().toUpperCase();
      }
      if (finalText.trim().length > 0) {
        addWordToWhisperList(finalText.trim().toUpperCase());
      }
    } else {
      currentTranscript += finalText;
      liveTranscript.textContent = currentTranscript + interimText;
    }
  };

  rec.onerror = (e) => console.error('Error reconocimiento:', e.error);

  rec.onend = () => {
    if (isRecording || isWhisperMode) {
      rec.start();
    }
  };

  return rec;
}

// CAPTURA DE AUDIO, AMPLIFICACION Y RETROALIMENTACION A AUDIFONOS
async function startRecordingProcess() {
  try {
    audioChunks = [];
    currentTranscript = '';
    liveTranscript.textContent = 'Escuchando audio...';

    // Desactivar procesamiento automatico nativo para no atenuar susurros
    const constraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    };

    const rawStream = await navigator.mediaDevices.getUserMedia(constraints);
    const ctx = await ensureAudioContextActive();

    const sourceNode = ctx.createMediaStreamSource(rawStream);

    // GainNode con factor 15.0 para amplificar frecuencias bajas
    const gainNode = ctx.createGain();
    gainNode.gain.value = 15.0;

    // Destino 1: Almacenamiento en Blob con MediaRecorder
    const destNode = ctx.createMediaStreamDestination();

    // Conexiones de la red de audio
    sourceNode.connect(gainNode);
    gainNode.connect(destNode);

    // Destino 2: Enviar señal amplificada directamente a la salida de audifonos
    gainNode.connect(ctx.destination);

    /* 
      LIMITACION TECNICA DOCUMENTADA:
      SpeechRecognition procesa la entrada nativa del dispositivo por limitaciones W3C,
      mientras que MediaRecorder y la salida a audifonos procesan el flujo amplificado por Web Audio API.
    */

    // Deteccion de codec de audio soportado segun plataforma (iOS / Android)
    let mimeType = '';
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      mimeType = 'audio/webm;codecs=opus';
    } else if (MediaRecorder.isTypeSupported('audio/webm')) {
      mimeType = 'audio/webm';
    } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
      mimeType = 'audio/mp4';
    }

    mediaRecorder = mimeType ? new MediaRecorder(destNode.stream, { mimeType }) : new MediaRecorder(destNode.stream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/wav' });
      await saveRecording(audioBlob, currentTranscript);

      rawStream.getTracks().forEach(track => track.stop());

      await loadLastRecording();
      renderRecordingsList();
    };

    mediaRecorder.start();

    if (!speechRecognition) {
      speechRecognition = initSpeechRecognition();
    }
    if (speechRecognition) {
      speechRecognition.start();
    }

    isRecording = true;
    updateUIState();

  } catch (err) {
    alert('No se pudo acceder al microfono o iniciar el canal de audio.');
    console.error(err);
  }
}

function stopRecordingProcess() {
  if (!isRecording && !isWhisperMode) return;

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  if (speechRecognition) {
    speechRecognition.stop();
  }

  isRecording = false;
  isWhisperMode = false;
  updateUIState();
}

function updateUIState() {
  if (isRecording) {
    btnStart.disabled = true;
    btnStop.disabled = false;
    btnStart.classList.add('recording');
    btnStart.textContent = 'Grabando...';
  } else {
    btnStart.disabled = false;
    btnStop.disabled = true;
    btnStart.classList.remove('recording');
    btnStart.textContent = 'Grabar';
  }
}

// CARGA Y CONFIGURACION DEL ULTIMO AUDIO
async function loadLastRecording() {
  const recordings = await getAllRecordings();
  if (recordings.length > 0) {
    lastAudioRecord = recordings[recordings.length - 1];

    if (lastAudioUrl) {
      URL.revokeObjectURL(lastAudioUrl);
    }

    lastAudioUrl = URL.createObjectURL(lastAudioRecord.audioBlob);
    mainAudioPlayer.src = lastAudioUrl;
    lastAudioTime.textContent = lastAudioRecord.date;
    btnPlayLast.disabled = false;

    // Vincular metadatos con el control multimedia nativo
    setupMediaSession(`Grabacion #${lastAudioRecord.id}`, lastAudioRecord.transcript);
  }
}

btnPlayLast.addEventListener('click', () => {
  if (mainAudioPlayer.src) {
    mainAudioPlayer.play();
  }
});

// LOGICA MODO SUSURRO EN PANTALLA
function addWordToWhisperList(word) {
  wordCount++;
  currentWordEl.textContent = word;

  setTimeout(() => {
    const item = document.createElement('div');
    item.className = 'word-item';
    item.textContent = `${wordCount}) ${word}`;
    wordsListEl.appendChild(item);

    currentWordEl.textContent = '';
    loaderEl.style.display = 'block';
  }, 1000);
}

btnStartWhisper.addEventListener('click', () => {
  isWhisperMode = true;
  wordCount = 0;
  wordsListEl.innerHTML = '';
  currentWordEl.textContent = '';
  loaderEl.style.display = 'block';
  whisperScreen.classList.add('active');

  startRecordingProcess();
});

whisperScreen.addEventListener('dblclick', () => {
  stopRecordingProcess();
  whisperScreen.classList.remove('active');
});

// BASE DE DATOS LOCAL (INDEXEDDB - CRUD)
function saveRecording(blob, transcript) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const item = {
      audioBlob: blob,
      transcript: transcript || 'Sin transcripción',
      date: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    const req = store.add(item);
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function getAllRecordings() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function deleteRecording(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

function updateTranscript(id, text) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const data = getReq.result;
      if (data) {
        data.transcript = text;
        store.put(data).onsuccess = () => resolve();
      }
    };
  });
}

async function renderRecordingsList() {
  recordingsList.innerHTML = '';
  const recordings = await getAllRecordings();

  if (recordings.length === 0) {
    recordingsList.innerHTML = '<p style="color: #444; text-align: center; font-size: 0.85rem;">No hay audios registrados.</p>';
    return;
  }

  recordings.reverse().forEach((item) => {
    const div = document.createElement('div');
    div.className = 'recording-item';
    const url = URL.createObjectURL(item.audioBlob);

    div.innerHTML = `
      <div class="item-header">
        <span>Audio #${item.id}</span>
        <span>${item.date}</span>
      </div>
      <div class="item-transcript" id="txt-${item.id}">${escapeHTML(item.transcript)}</div>
      <audio controls src="${url}"></audio>
      <div class="item-actions">
        <button class="btn-secondary btn-sm" onclick="editItem(${item.id})">Editar</button>
        <button class="btn-danger btn-sm" onclick="deleteItem(${item.id})">Eliminar</button>
      </div>
    `;

    recordingsList.appendChild(div);
  });
}

function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}

window.deleteItem = async function(id) {
  if (confirm('¿Eliminar registro de audio?')) {
    await deleteRecording(id);
    await loadLastRecording();
    renderRecordingsList();
  }
};

window.editItem = async function(id) {
  const current = document.getElementById(`txt-${id}`).textContent;
  const val = prompt('Modificar transcripcion:', current);
  if (val && val.trim() !== '') {
    await updateTranscript(id, val.trim());
    renderRecordingsList();
  }
};

// INICIALIZACION
window.addEventListener('DOMContentLoaded', async () => {
  await initDB();
  await loadLastRecording();
  renderRecordingsList();

  btnStart.addEventListener('click', startRecordingProcess);
  btnStop.addEventListener('click', stopRecordingProcess);
});