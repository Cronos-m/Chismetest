// Registrador del Service Worker para funcionalidad PWA Offline
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => console.log('Service Worker registrado correctamente.', reg))
      .catch((err) => console.error('Error al registrar Service Worker:', err));
  });
}

// Globales del Estado de la Aplicacion
let db = null;
let audioContext = null;
let mediaRecorder = null;
let speechRecognition = null;
let audioChunks = [];
let currentTranscript = '';
let isRecording = false;

// Elementos de la Interfaz de Usuario
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const liveTranscript = document.getElementById('live-transcript');
const recordingsList = document.getElementById('recordings-list');

// CONFIGURACION DE INDEXEDDB (Base de Datos Local)
const DB_NAME = 'HermesAudioDB';
const DB_VERSION = 1;
const STORE_NAME = 'recordings';

function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => {
      console.error('Error al abrir IndexedDB:', event.target.error);
      reject(event.target.error);
    };

    request.onsuccess = (event) => {
      db = event.target.result;
      resolve(db);
    };

    // Creacion de la estructura del almacen de datos en la primera ejecucion
    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };
  });
}

// INICIALIZACION DE RECONOCIMIENTO DE VOZ (SpeechRecognition API)
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  
  if (!SpeechRecognition) {
    liveTranscript.textContent = 'SpeechRecognition no es soportado en este navegador.';
    return null;
  }

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'es-ES';

  recognition.onresult = (event) => {
    let interimTranscript = '';
    let finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
      } else {
        interimTranscript += event.results[i][0].transcript;
      }
    }

    currentTranscript += finalTranscript;
    liveTranscript.textContent = currentTranscript + interimTranscript;
  };

  recognition.onerror = (event) => {
    console.error('Error en reconocimiento de voz:', event.error);
  };

  return recognition;
}

// LOGICA DE CAPTURA Y AMPLIFICACION DE AUDIO
async function startRecording() {
  try {
    audioChunks = [];
    currentTranscript = '';
    liveTranscript.textContent = 'Escuchando...';

    // Se solicitan permisos desactivando el procesamiento automatico del navegador
    // Esto permite que el GainNode amplifique la señal limpia sin cancelaciones destructivas
    const constraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    };

    const rawStream = await navigator.mediaDevices.getUserMedia(constraints);

    // Inicialización del Contexto de Audio
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass();

    // Creacion del nodo de origen desde el stream del microfono
    const sourceNode = audioContext.createMediaStreamSource(rawStream);

    // Creacion del nodo de ganancia para amplificacion de sonidos bajos
    const gainNode = audioContext.createGain();
    gainNode.gain.value = 15.0; // Factor de amplificacion x15

    // Destino para enviar el flujo de audio amplificado
    const destinationNode = audioContext.createMediaStreamDestination();

    // Conexion de nodos del grafo de audio
    sourceNode.connect(gainNode);
    gainNode.connect(destinationNode);

    /* 
      LIMITACION TECNICA Y NOTA DE ARQUITECTURA:
      La API nativa SpeechRecognition no permite seleccionar una fuente MediaStream personalizada 
      (como el destino amplificado del Web Audio API). Se conecta automaticamente al dispositivo 
      por defecto del sistema.
      Por esta razon, la transcripcion procesa la entrada directa del sistema, mientras que la 
      grabacion persistente (MediaRecorder) recibe el stream amplificado por el GainNode.
    */

    // Se inicializa el MediaRecorder con el stream amplificado
    const amplifiedStream = destinationNode.stream;
    
    // Verificacion del tipo MIME soportado para navegadores (iOS / Android)
    let mimeType = 'audio/webm';
    if (!MediaRecorder.isTypeSupported('audio/webm')) {
      if (MediaRecorder.isTypeSupported('audio/mp4')) {
        mimeType = 'audio/mp4'; // Opcion comun para Safari iOS
      } else {
        mimeType = ''; // El navegador elegira el valor por defecto
      }
    }

    mediaRecorder = mimeType ? new MediaRecorder(amplifiedStream, { mimeType }) : new MediaRecorder(amplifiedStream);

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/wav' });
      await saveRecording(audioBlob, currentTranscript);
      
      // Detener los tracks del microfono para liberar el hardware
      rawStream.getTracks().forEach(track => track.stop());
      if (audioContext && audioContext.state !== 'closed') {
        await audioContext.close();
      }
      
      renderRecordings();
    };

    // Iniciar grabacion de audio y transcripcion
    mediaRecorder.start();
    
    if (speechRecognition) {
      speechRecognition.start();
    }

    isRecording = true;
    updateUIState();

  } catch (err) {
    console.error('Error al acceder al microfono:', err);
    alert('No se pudo acceder al microfono. Por favor, concede los permisos necesarios.');
  }
}

function stopRecording() {
  if (!isRecording) return;

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  if (speechRecognition) {
    speechRecognition.stop();
  }

  isRecording = false;
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

// FUNCIONES OPERATIVAS CRUD EN INDEXEDDB

function saveRecording(blob, transcript) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    const record = {
      audioBlob: blob,
      transcript: transcript || 'Sin transcripcion disponible.',
      date: new Date().toLocaleString()
    };

    const request = store.add(record);

    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

function getAllRecordings() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

function deleteRecording(id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);

    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e.target.error);
  });
}

function updateRecordingTranscript(id, newTranscript) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const getRequest = store.get(id);

    getRequest.onsuccess = () => {
      const data = getRequest.result;
      if (data) {
        data.transcript = newTranscript;
        const updateRequest = store.put(data);
        updateRequest.onsuccess = () => resolve();
        updateRequest.onerror = (e) => reject(e.target.error);
      } else {
        reject('Registro no encontrado.');
      }
    };
    getRequest.onerror = (e) => reject(e.target.error);
  });
}

// RENDERIZADO DE INTERFAZ Y REPRODUCCION
async function renderRecordings() {
  recordingsList.innerHTML = '';
  const recordings = await getAllRecordings();

  if (recordings.length === 0) {
    recordingsList.innerHTML = '<p style="color: #666; text-align: center;">No hay grabaciones guardadas.</p>';
    return;
  }

  // Se ordenan las grabaciones en orden descendente (mas recientes primero)
  recordings.reverse().forEach((item) => {
    const itemDiv = document.createElement('div');
    itemDiv.className = 'recording-item';

    // Generacion de URL temporal para el control <audio> nativo del navegador
    const audioUrl = URL.createObjectURL(item.audioBlob);

    itemDiv.innerHTML = `
      <div class="recording-header">
        <span>ID: ${item.id}</span>
        <span>${item.date}</span>
      </div>
      <div class="recording-transcript" id="transcript-text-${item.id}">${escapeHTML(item.transcript)}</div>
      <audio controls src="${audioUrl}"></audio>
      <div class="item-actions">
        <button class="btn-edit" onclick="editTranscript(${item.id})">Editar Texto</button>
        <button class="btn-delete" onclick="removeRecord(${item.id})">Eliminar</button>
      </div>
    `;

    recordingsList.appendChild(itemDiv);
  });
}

// Manejadores globales para los botones dentro del listado dinámico
window.removeRecord = async function(id) {
  if (confirm('¿Desea eliminar esta grabacion?')) {
    await deleteRecording(id);
    renderRecordings();
  }
};

window.editTranscript = async function(id) {
  const textElement = document.getElementById(`transcript-text-${id}`);
  const currentText = textElement.textContent;
  const newText = prompt('Modificar transcripcion:', currentText);

  if (newText !== null && newText.trim() !== '') {
    await updateRecordingTranscript(id, newText.trim());
    renderRecordings();
  }
};

function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}

// INICIALIZACION DE LA APLICACION
window.addEventListener('DOMContentLoaded', async () => {
  await initDB();
  speechRecognition = initSpeechRecognition();

  btnStart.addEventListener('click', startRecording);
  btnStop.addEventListener('click', stopRecording);

  renderRecordings();
});